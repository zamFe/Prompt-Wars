// Multiplayer: everyone with the artifact open shares one arena.
//
// One page simulates (the host, chosen deterministically as the lowest peer
// label so every page agrees without a negotiation) and broadcasts the world
// several times a second. Every other page renders what it receives and never
// runs physics, so there is nothing to diverge.
//
// Thinking is routed the other way. When an agent needs a decision the host
// asks ITS OWNER's page, which calls Claude on that viewer's own account and
// sends the plan back. So each player pays for their own fighters and nobody
// pays for anyone else's. An agent whose owner has closed the page falls back
// to the host's offline brain rather than freezing.
//
// Chat follows the same split. What an agent says out loud rides in the roster
// message, so every page sees it; what it says to its operator never leaves the
// operator's page at all.
//
// Every failure here degrades to playing alone: the page is complete on its
// own and the room only ever lights it up.

import { WEAPONS } from './config.js';

export const TOPICS = {
  tick: 'tick', roster: 'roster', join: 'join', plan: 'plan', need: 'need', part: 'part',
  // What game is being played, and how it stands. Sent by the host, read by
  // everyone, so a guest's screen follows the host through every phase.
  phase: 'phase',
  // Admin-only: these are deliberately NOT opened to the interact level at
  // publish time, so the platform refuses them from anyone below Editor.
  // `setup` carries every lobby decision - mode, map, rules, teams, start.
  bots: 'bots', clear: 'clear', setup: 'setup',
};
const TICK_HZ = 8;
const WEAPON_IDS = Object.keys(WEAPONS);

const r0 = (n) => Math.round(n);
const r1 = (n) => Math.round(n * 10) / 10;

/** The arena as a few hundred bytes: positions now, identities separately. */
export function encodeSnapshot(world) {
  return {
    t: r1(world.time),
    a: world.agents.map((a) => [
      a.netId, r0(a.x), r0(a.y), r0(a.facing), r0(a.aimOffset), r0(a.hp),
      WEAPON_IDS.indexOf(a.weapon), a.ammo,
    ]),
    p: world.projectiles.slice(0, 40).map((p) => [r0(p.x), r0(p.y), r1(p.dx), r1(p.dy)]),
    k: world.pickups.map((k) => [r0(k.x), r0(k.y), k.kind === 'health' ? k.heal : WEAPON_IDS.indexOf(k.weaponId) + 100]),
  };
}

/** Who is in the arena, sent only when it changes. */
export function encodeRoster(world) {
  return world.agents.map((a) => [
    a.netId, a.name, a.participant.colorIndex, a.participant.ownerId ?? null,
    a.participant.kills, a.participant.assists ?? 0, a.chat?.text ?? null,
    a.team ?? null, a.carrying ?? null,
  ]);
}

/**
 * Who simulates. Lowest peer label wins, so every page agrees without a
 * negotiation - but only among peers that can actually SEND. A Viewer on an
 * artifact may not send on any topic at all, so a Viewer elected host would
 * broadcast nothing and freeze the game for everyone. Each page finds out
 * whether it can send and says so in its presence; a peer that has not said
 * yet is given the benefit of the doubt, so the room is never left hostless.
 */
export function electHost(peers, me = null) {
  const viewers = peers.filter((p) => p.kind === 'viewer');
  const able = viewers.filter((p) => p.presence?.canHost !== false);
  return (able.length ? able : viewers).map((p) => p.peer).sort()[0] ?? me;
}

export function createNet({ world, makeGhost, onState = () => {} } = {}) {
  let room = null;
  let me = null;                 // my peer label
  let hostPeer = null;
  let unsubscribes = [];
  let tickTimer = null;
  let lastRosterKey = '';
  const pendingNeeds = new Map();

  // `canSend` is null until this page has found out, then true or false. False
  // means this viewer is here at Viewer level: it can watch, never act.
  const state = { connected: false, isHost: true, peers: 1, available: false, canSend: null, error: null };
  const publish = () => onState({ ...state });

  const stopTicking = () => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  };

  const startTicking = () => {
    stopTicking();
    tickTimer = setInterval(() => {
      if (!room || !state.isHost) return;
      room.emit(TOPICS.tick, encodeSnapshot(world)).catch(() => {});

      const rosterKey = world.agents
        .map((a) => `${a.netId}:${a.participant.kills}:${a.team ?? ''}:${a.carrying ?? ''}:${a.chat?.text ?? ''}`)
        .join('|');
      if (rosterKey !== lastRosterKey) {
        lastRosterKey = rosterKey;
        room.emit(TOPICS.roster, encodeRoster(world)).catch(() => {});
      }

    }, 1000 / TICK_HZ);
  };

  return {
    get state() {
      return { ...state };
    },
    get isHost() {
      return state.isHost;
    },
    get hostPeer() {
      return hostPeer;
    },
    get me() {
      return me;
    },

    async connect() {
      try {
        room = (await globalThis.claude?.use?.('room')) ?? null;
      } catch {
        room = null;
      }
      if (!room) {
        state.error = 'no-room';
        publish();
        return false;
      }
      state.available = true;

      // Can this page send at all? There is no call that answers it, so ask
      // the platform the only way it answers: send something nobody acts on.
      // A tick from a non-host is ignored by every page, and a host ignores
      // ticks entirely. `not_permitted` means Viewer level - say so in
      // presence, so this page is never elected to run a game it cannot
      // broadcast.
      room.emit(TOPICS.tick, { probe: true })
        .then(() => true, (error) => error?.code !== 'not_permitted')
        .then((canSend) => {
          state.canSend = canSend;
          room.presence({ canHost: canSend }).catch(() => {});
          publish();
        });

      unsubscribes.push(room.onConnection((connected) => {
        state.connected = connected;
        publish();
      }));

      unsubscribes.push(room.onPeers((change) => {
        const peers = change.peers;
        me ??= peers.find((p) => p.isMe && p.sameTab)?.peer ?? null;
        state.peers = peers.filter((p) => p.kind === 'viewer').length || 1;

        const elected = electHost(peers, me);
        const wasHost = state.isHost;
        hostPeer = elected;
        state.isHost = elected === me || !elected;

        if (state.isHost && !wasHost) startTicking();
        if (!state.isHost && wasHost) stopTicking();
        publish();
      }));

      // --- as a guest: render what the host sends ---------------------------
      unsubscribes.push(room.on(TOPICS.tick, (msg) => {
        if (state.isHost || msg.peer !== hostPeer) return;   // only the host's word counts
        applySnapshot(world, msg.data, makeGhost);
      }));

      unsubscribes.push(room.on(TOPICS.roster, (msg) => {
        if (state.isHost || msg.peer !== hostPeer) return;
        applyRoster(world, msg.data, makeGhost);
      }));

      // --- as the host: take in players and their plans ---------------------
      unsubscribes.push(room.on(TOPICS.join, (msg) => {
        if (!state.isHost || msg.isMe) return;
        this.onJoinRequest?.(msg.data, msg);
      }));

      unsubscribes.push(room.on(TOPICS.plan, (msg) => {
        if (!state.isHost) return;
        const pending = pendingNeeds.get(msg.data?.id);
        if (!pending) return;
        pendingNeeds.delete(msg.data.id);
        pending.resolve(msg.data);
      }));

      unsubscribes.push(room.on(TOPICS.part, (msg) => {
        if (!state.isHost || msg.isMe) return;
        this.onPartRequest?.(msg.data, msg);
      }));

      // --- as a player: answer the host's request for my agent's decision ---
      unsubscribes.push(room.on(TOPICS.bots, (msg) => {
        if (state.isHost) this.onBotsRequest?.(msg.data, msg);
      }));

      unsubscribes.push(room.on(TOPICS.clear, (msg) => {
        if (state.isHost) this.onClearRequest?.(msg.data, msg);
      }));

      unsubscribes.push(room.on(TOPICS.need, (msg) => {
        if (state.isHost) return;
        this.onDecisionNeeded?.(msg.data);
      }));

      // What game is being played. The host is the only voice that counts.
      unsubscribes.push(room.on(TOPICS.phase, (msg) => {
        if (state.isHost || msg.peer !== hostPeer) return;
        this.onPhase?.(msg.data);
      }));

      // Admin-only, so the platform has already refused anyone below Editor by
      // the time this runs.
      unsubscribes.push(room.on(TOPICS.setup, (msg) => {
        if (state.isHost) this.onSetupRequest?.(msg.data, msg);
      }));

      startTicking();
      publish();
      return true;
    },

    /** Host side: ask an agent's owner to think, with a deadline. */
    askOwner(agentId, ownerPeer, payload, timeoutMs) {
      if (!room || !state.isHost) return Promise.reject(new Error('not host'));
      const id = `${agentId}:${Date.now()}`;
      return new Promise((resolve, reject) => {
        pendingNeeds.set(id, { resolve, reject });
        room.emit(TOPICS.need, { ...payload, id, agentId, owner: ownerPeer }).catch(() => {});
        setTimeout(() => {
          if (pendingNeeds.delete(id)) reject(new Error('owner did not answer'));
        }, timeoutMs);
      });
    },

    send(topic, data) {
      return room?.emit(topic, data).catch(() => {}) ?? Promise.resolve();
    },

    setPresence(patch) {
      return room?.presence(patch).catch(() => {}) ?? Promise.resolve();
    },

    disconnect() {
      stopTicking();
      for (const off of unsubscribes) {
        try { off(); } catch { /* already gone */ }
      }
      unsubscribes = [];
      room = null;
    },
  };
}

/** Write a host snapshot into a guest's world, which never runs physics. */
export function applySnapshot(world, data, makeGhost) {
  if (!data || !Array.isArray(data.a)) return;
  world.time = data.t ?? world.time;

  const seen = new Set();
  for (const [netId, x, y, facing, aim, hp, weaponIdx, ammo] of data.a) {
    seen.add(netId);
    let agent = world.agents.find((a) => a.netId === netId);
    if (!agent) {
      agent = makeGhost(netId);
      if (!agent) continue;
      world.agents.push(agent);
    }
    // The host owns the truth; a guest only moves what it is told to move.
    agent.x = x;
    agent.y = y;
    agent.facing = facing;
    agent.aimOffset = aim;
    agent.hp = hp;
    agent.weapon = WEAPON_IDS[weaponIdx] ?? 'pistol';
    agent.ammo = ammo;
    agent.alive = hp > 0;
  }
  world.agents = world.agents.filter((a) => seen.has(a.netId));

  world.projectiles = (data.p ?? []).map(([x, y, dx, dy]) => ({
    x, y, dx, dy, color: '#e8e8f0', speed: 0, travelled: 0, range: 1,
  }));

  world.pickups = (data.k ?? []).map(([x, y, code], i) => (code >= 100
    ? { id: `g${i}`, kind: 'weapon', weaponId: WEAPON_IDS[code - 100] ?? 'shotgun', x, y, radius: 13,
        color: WEAPONS[WEAPON_IDS[code - 100]]?.color ?? '#ffb347', label: 'Weapon', expiresAt: Infinity }
    : { id: `g${i}`, kind: 'health', heal: code, x, y, radius: code >= 50 ? 14 : code >= 25 ? 10 : 7,
        color: code >= 50 ? '#26f5c4' : code >= 25 ? '#38d97a' : '#7fdba0', label: `Medkit +${code}`, expiresAt: Infinity }));
}

/** Identities and scores, which change far less often than positions. */
export function applyRoster(world, rows, makeGhost) {
  if (!Array.isArray(rows)) return;
  for (const [netId, name, colorIndex, ownerId, kills, assists, chat, team, carrying] of rows) {
    let agent = world.agents.find((a) => a.netId === netId);
    if (!agent) {
      agent = makeGhost(netId);
      if (!agent) continue;
      world.agents.push(agent);
    }
    agent.name = String(name ?? 'agent').slice(0, 14);
    agent.participant.name = agent.name;
    agent.participant.colorIndex = Number(colorIndex) || 0;
    agent.participant.ownerId = ownerId ?? null;
    agent.participant.kills = Number(kills) || 0;
    agent.participant.assists = Number(assists) || 0;
    agent.team = team === 'a' || team === 'b' ? team : null;
    agent.participant.team = agent.team;
    agent.carrying = carrying === 'a' || carrying === 'b' ? carrying : null;
    // Raised through say() rather than written straight onto the agent, so a
    // guest's global chat fills from the host's arena exactly as the host's own
    // does. Private replies never travel: they are produced on, and stay on,
    // the page that owns the agent.
    if (chat && agent.chat?.text !== chat) world.say(agent, String(chat));
  }
}
