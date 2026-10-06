// The match: what game is being played, who is on which side, and what the
// screen is showing.
//
// Everything here is phase-driven. A page is always in exactly one phase, and
// the phase decides what runs: the simulation only ticks in `live`, the join
// form only accepts prompts in `briefing`, and the arena is only ever torn down
// between rounds. Keeping that in one place is what stops "is a round running?"
// from being answered three different ways in three different files.
//
// The host owns this object. Guests mirror its public state over the room and
// never advance it themselves.

import { MATCH, TEAMS } from './config.js';
import { isHex } from './colors.js';
import { setMap, baseOf, MAPS } from './arena.js';
import { dist } from './util.js';

export const PHASES = {
  landing: 'landing',     // the title card, before anyone has touched anything
  lobby: 'lobby',         // choosing mode, map, teams; the owner starts the round
  briefing: 'briefing',   // everyone writes the prompt their fighter will carry
  live: 'live',           // the round itself
  postgame: 'postgame',   // podium, scoreboard, and the winner's speech
};

/**
 * The three ways to play. Each one answers the same two questions - what scores
 * a point, and who is on your side - and nothing else in the game needs to know
 * which mode is running.
 */
export const MODES = {
  ffa: {
    id: 'ffa',
    name: 'Free-for-all',
    short: 'FFA',
    teams: false,
    blurb: 'Everyone for themselves. A kill is a point. Most points when the clock runs out.',
    scoreWord: 'kills',
    briefing:
      'Every other sphere in this arena is an enemy. There are no allies and nobody is coming to help you. ' +
      'A kill is worth a point; dying costs you a life.',
  },
  tdm: {
    id: 'tdm',
    name: 'Team deathmatch',
    short: 'TDM',
    teams: true,
    blurb: 'Two teams. Every kill scores for your side. Highest team total wins.',
    scoreWord: 'kills',
    briefing:
      'You fight for your team. Killing an enemy scores a point for your side; your own fire passes harmlessly ' +
      'through your teammates, so you can shoot past them. Your team wins or loses together - your personal ' +
      'score decides nothing on its own.',
  },
  ctf: {
    id: 'ctf',
    name: 'Capture the flag',
    short: 'CTF',
    teams: true,
    blurb: 'Carry the enemy flag back to your own base. Kills score nothing at all.',
    scoreWord: 'captures',
    briefing:
      'Kills score NOTHING in this mode. The only thing that scores is carrying the enemy flag to your own base, ' +
      'and that only counts while your own flag is at home. Walking onto a flag picks it up - there is no tool for ' +
      'it and there does not need to be. If you are carrying and you die, the flag drops where you fell: your ' +
      'team returns it by touching it, the enemy picks it up and runs. Killing still matters, but only because a ' +
      'dead carrier drops what they were carrying.',
  },
  commander: {
    id: 'commander',
    name: 'Commander',
    short: 'CMD',
    teams: true,
    squad: 4,
    // The only mode where speech is the mechanic rather than the flavour, so
    // the global chat is split into one channel per side.
    teamChat: true,
    blurb: 'One agent a side, each commanding four bots. Your voice is the only thing they hear.',
    scoreWord: 'kills',
    commanderBounty: 5,
    briefing:
      'You are a COMMANDER. Four bots fight for you, listed below with their codenames and where they started. ' +
      'They are not clever and they cannot see what you see - but they do what they are told, and the only way ' +
      'to tell them anything is to SAY IT OUT LOUD. Your "say" line is your radio.\n' +
      'Address one of them by codename ("HAWK, hold the left wall") and only that one acts on it. Say it without ' +
      'a codename and the whole squad takes it. They only hear you within earshot, and so does the enemy ' +
      'commander if they are close enough - talking gives your position away.\n' +
      'Orders they understand are plain tactics: push, hold, fall back, regroup, go left, go right, watch the ' +
      'flanks, spread out, conserve ammo, open fire. Keep each order to one short line.\n' +
      'A kill scores for your side. Killing the enemy commander is worth five.',
  },
};

export const MODE_LIST = Object.values(MODES);

/** Squad codenames, one set a side, so a call-sign is never ambiguous. */
export const CODENAMES = {
  a: ['HAWK', 'BISHOP', 'EMBER', 'RUST'],
  b: ['FROST', 'MARLIN', 'COBALT', 'DRIFT'],
};

/**
 * What a fighter is told about the round before it starts: what game this is,
 * which side it is on, and what actually scores. It goes in the same place as
 * the standing orders - fixed for the whole life, highest authority, cached -
 * because it is the one thing the orders are written against.
 */
export function missionBriefing(mission) {
  if (!mission) return '';
  const lines = [`THIS ROUND: ${mission.modeName}.`, mission.briefing];

  if (mission.team) {
    lines.push(
      `You are on ${mission.teamName}. Teammates are listed separately from enemies in every report you get. ` +
        'Never shoot at a name on your own list, and never count on one to get out of your way.',
    );
  }
  lines.push(
    `The round runs for ${Math.round(mission.roundSeconds / 60)} minutes, and your clock is in every report.`,
  );
  lines.push(
    mission.lives
      ? `You have ${mission.lives} ${mission.lives === 1 ? 'life' : 'lives'}. When they are gone you are out of the round and you watch the rest of it from the sidelines.`
      : 'You come back indefinitely, so dying costs you time and nothing else.',
  );
  if (mission.squad?.length) {
    lines.push('');
    lines.push('YOUR SQUAD, as they stood when the round began (direction is relative to your own facing):');
    for (const member of mission.squad) {
      lines.push(`- ${member.codename}: ${member.distance} units to your ${member.direction}`);
    }
    lines.push('Those are their starting positions, not where they are now. They move when you tell them to.');
  }

  lines.push('Your standing orders are written for this round. Where they are silent, play the mode.');
  return lines.join('\n');
}

/** Flag auto-return, so a dropped flag in a corner cannot stall a round. */
const FLAG_RETURN_SECONDS = 30;
const CAPTURE_RADIUS = 46;

export function defaultSettings() {
  return { ...MATCH.defaults };
}

/**
 * Scores, flags and the clock. `world` is the simulation it drives; it is
 * deliberately the only thing in here that knows about bodies.
 */
export function createMatch({ world, onPhase = () => {}, onEvent = () => {}, onFormUp = null } = {}) {
  let phase = PHASES.landing;
  let settings = defaultSettings();
  let clock = 0;              // seconds spent in the current phase
  let limit = 0;              // how long this phase lasts, 0 = no limit
  let scores = { a: 0, b: 0 };
  let flags = null;
  let results = null;
  // The people in the lobby, keyed by seat: a peer label in a shared room,
  // "local" on a page running alone. A seat is a person; a fighter is what
  // they send into a round. `side` is null while they spectate.
  let seats = {};
  let startedAt = null;

  const mode = () => MODES[settings.mode] ?? MODES.ffa;

  const enter = (next, seconds = 0) => {
    phase = next;
    clock = 0;
    limit = seconds;
    onPhase(api.state);
  };

  /** Both flags home, which is also how a round starts. */
  const resetFlags = () => {
    flags = mode().id === 'ctf'
      ? {
          a: { team: 'a', state: 'home', carrier: null, ...baseOf('a'), since: 0 },
          b: { team: 'b', state: 'home', carrier: null, ...baseOf('b'), since: 0 },
        }
      : null;
  };

  /** A team's own flag must be at home for a capture to count. */
  const flagAtHome = (team) => !flags || flags[team].state === 'home';

  const carrierOf = (flag) => world.agents.find((a) => a.id === flag.carrier) ?? null;

  const sendHome = (flag) => {
    const base = baseOf(flag.team);
    flag.state = 'home';
    flag.carrier = null;
    flag.x = base.x;
    flag.y = base.y;
    flag.since = world.time;
  };

  const stepFlags = () => {
    if (!flags) return;

    for (const flag of Object.values(flags)) {
      // A carried flag rides on its carrier, and drops the moment they stop
      // being a live body - died, left, or the round ended under them.
      if (flag.state === 'carried') {
        const carrier = carrierOf(flag);
        if (!carrier || !carrier.alive) {
          flag.state = 'dropped';
          flag.carrier = null;
          flag.since = world.time;
        } else {
          flag.x = carrier.x;
          flag.y = carrier.y;
          continue;
        }
      }

      if (flag.state === 'dropped' && world.time - flag.since > FLAG_RETURN_SECONDS) {
        sendHome(flag);
        onEvent(`${TEAMS[flag.team].name}'s flag returned itself.`, 'objective');
      }
    }

    for (const agent of world.agents) {
      if (!agent.alive || !agent.team) continue;
      const own = flags[agent.team];
      const enemy = flags[agent.team === 'a' ? 'b' : 'a'];

      // Touching your own flag: send it home if it is lying out, or cash in a
      // capture if you are standing on your base carrying theirs.
      if (dist(agent.x, agent.y, own.x, own.y) <= CAPTURE_RADIUS) {
        if (own.state === 'dropped') {
          sendHome(own);
          agent.participant.returns = (agent.participant.returns ?? 0) + 1;
          agent.pendingEvents.push('You returned your own flag to base.');
          onEvent(`${agent.name} returned their flag.`, 'objective');
        } else if (own.state === 'home' && enemy.carrier === agent.id) {
          sendHome(enemy);
          scores[agent.team] += 1;
          agent.participant.captures = (agent.participant.captures ?? 0) + 1;
          agent.carrying = null;
          agent.pendingEvents.push('YOU SCORED. You carried the enemy flag home.');
          world.pulse(agent, 'kill');
          onEvent(`${agent.name} captured the flag! ${TEAMS[agent.team].name} ${scores[agent.team]}.`, 'objective');
        }
      }

      // Touching theirs: pick it up, wherever it was standing.
      if (enemy.state !== 'carried' && dist(agent.x, agent.y, enemy.x, enemy.y) <= CAPTURE_RADIUS) {
        enemy.state = 'carried';
        enemy.carrier = agent.id;
        enemy.since = world.time;
        agent.carrying = enemy.team;
        agent.pendingEvents.push('You picked up the enemy flag. Carry it to your own base to score.');
        onEvent(`${agent.name} took ${TEAMS[enemy.team].name}'s flag.`, 'objective');
      }
    }

    for (const agent of world.agents) {
      agent.carrying = Object.values(flags).find((f) => f.carrier === agent.id)?.team ?? null;
    }
  };

  const api = {
    get phase() {
      return phase;
    },
    get settings() {
      return { ...settings };
    },
    get mode() {
      return mode();
    },
    get scores() {
      return { ...scores };
    },
    get flags() {
      return flags;
    },
    get results() {
      return results;
    },
    get isTeamMode() {
      return mode().teams;
    },
    /** Seconds left in this phase, or null when the phase does not run out. */
    get remaining() {
      return limit ? Math.max(0, limit - clock) : null;
    },

    /** Everything a guest needs to render the same screen the host is on. */
    get state() {
      return {
        phase,
        settings: { ...settings },
        scores: { ...scores },
        remaining: api.remaining,
        mode: mode().id,
        teams: mode().teams,
        flags: flags
          ? Object.fromEntries(Object.entries(flags).map(([k, f]) => [k, { state: f.state, x: Math.round(f.x), y: Math.round(f.y) }]))
          : null,
        results,
        seats: Object.fromEntries(Object.entries(seats).map(([id, seat]) => [id, { ...seat }])),
      };
    },

    get seats() {
      return seats;
    },

    /** The sides a person can take in this mode, spectating aside. */
    sideOptions() {
      return mode().teams ? ['a', 'b'] : ['play'];
    },

    /**
     * Rebuild the seat list from who is actually present. Everyone arrives
     * spectating; a person already seated keeps their side; a person who has
     * left takes their seat with them.
     */
    syncSeats(present = []) {
      const next = {};
      for (const person of present) {
        if (!person?.id || !person.name) continue;
        const kept = seats[person.id];
        next[person.id] = {
          name: String(person.name).slice(0, 18),
          color: isHex(person.color) ? person.color : '#8b93a7',
          side: kept?.side ?? null,
          // A Viewer can watch and nothing else, so it is never offered a side.
          canPlay: person.canPlay !== false,
        };
      }
      const changed = JSON.stringify(next) !== JSON.stringify(seats);
      seats = next;
      if (changed) onPhase(api.state);
      return changed;
    },

    /**
     * Put a person on a side, or back in the stands. The owner can do this to
     * anyone; a person can do it only to themselves, which the host enforces by
     * taking the seat from the platform-stamped sender, never from the message.
     */
    setSide(seatId, side) {
      const seat = seats[seatId];
      if (!seat) return false;
      const wanted = side === null || this.sideOptions().includes(side) ? side : null;
      if (wanted && !seat.canPlay) return false;

      // Commander is one person a side.
      if (wanted && mode().squad) {
        const taken = Object.entries(seats).some(([id, other]) => id !== seatId && other.side === wanted) ||
          world.lobby.list().some((p) => p.role === 'commander' && !p.seat && p.team === wanted);
        if (taken) return false;
      }

      seat.side = wanted;
      onPhase(api.state);
      return true;
    },

    /** A team mode's sides, or "playing", follow a change of mode. */
    reseat(nextMode) {
      for (const seat of Object.values(seats)) {
        if (!seat.side) continue;
        if (nextMode.teams && seat.side === 'play') seat.side = null;
        if (!nextMode.teams && seat.side !== 'play') seat.side = 'play';
      }
    },

    /** Any key or click leaves the title card. */
    begin() {
      if (phase === PHASES.landing) this.toLobby();
    },

    /**
     * Commander mode is one agent a side, and the arena holds exactly ten: two
     * commanders and their eight. So switching into it trims the lobby to one
     * commander per side, and switching out of it clears the squads, which are
     * round furniture rather than players.
     */
    trimToCommanders() {
      const kept = { a: null, b: null };
      const other = (team) => (team === 'a' ? 'b' : 'a');
      const ordered = [...world.lobby.list()].sort((x, y) => x.joinedAt - y.joinedAt);

      for (const participant of ordered) {
        if (participant.role === 'squad') {
          world.lobby.remove(participant.id);
          continue;
        }
        const want = participant.team === 'b' ? 'b' : 'a';
        const side = !kept[want] ? want : !kept[other(want)] ? other(want) : null;
        if (!side) {
          world.lobby.remove(participant.id);
          continue;
        }
        kept[side] = participant;
        participant.team = side;
        participant.role = 'commander';
      }
      return kept;
    },

    /**
     * Fighters belong to people, and people sit where they sit. A fighter whose
     * person has gone to the stands - or left - leaves with them; one whose
     * person changed sides changes with them.
     */
    fieldSeats() {
      for (const participant of world.lobby.list()) {
        if (!participant.seat) continue;
        const seat = seats[participant.seat];
        if (!seat?.side) {
          world.lobby.remove(participant.id);
          continue;
        }
        participant.team = seat.side === 'a' || seat.side === 'b' ? seat.side : null;
        participant.favColor = seat.color;
      }
    },

    /** Which sides still have room for a commander. */
    freeCommandSlot() {
      const taken = (team) => world.lobby.list().some((p) => p.team === team && p.role === 'commander') ||
        Object.values(seats).some((seat) => seat.side === team);
      return !taken('a') ? 'a' : !taken('b') ? 'b' : null;
    },

    dropSquads() {
      for (const participant of world.lobby.list()) {
        if (participant.role === 'squad') world.lobby.remove(participant.id);
      }
    },

    configure(patch = {}) {
      const before = settings.mode;
      const next = { ...settings, ...patch };
      next.mode = MODES[next.mode] ? next.mode : 'ffa';
      next.map = MAPS.some((m) => m.id === next.map) ? next.map : MAPS[0].id;
      next.roundSeconds = clampNumber(next.roundSeconds, MATCH.limits.roundSeconds, settings.roundSeconds);
      next.briefSeconds = clampNumber(next.briefSeconds, MATCH.limits.briefSeconds, settings.briefSeconds);
      next.lives = clampNumber(next.lives, MATCH.limits.lives, settings.lives);
      settings = next;

      if (next.mode !== before) {
        api.reseat(MODES[next.mode]);
        // Squads belong to the mode that raised them.
        api.dropSquads();
        if (MODES[next.mode].squad) api.trimToCommanders();
        else for (const p of world.lobby.list()) p.role = null;
      }

      if (phase === PHASES.lobby) setMap(settings.map);
      onPhase(api.state);
      return settings;
    },

    toLobby() {
      world.clearArena?.({ keepParticipants: true });
      scores = { a: 0, b: 0 };
      flags = null;
      results = null;
      startedAt = null;
      setMap(settings.map);
      enter(PHASES.lobby);
    },

    /** The owner has started the round: everyone gets the clock to write. */
    openBriefing() {
      if (phase !== PHASES.lobby) return false;
      api.fieldSeats();
      if (mode().squad) api.trimToCommanders();
      world.clearArena?.({ keepParticipants: true });
      scores = { a: 0, b: 0 };
      results = null;
      setMap(settings.map);
      enter(PHASES.briefing, settings.briefSeconds);
      return true;
    },

    /** The writing time is up (or the owner skipped it): fight. */
    goLive() {
      if (phase !== PHASES.briefing) return false;
      // Squads are raised before the round, so they spawn with everyone else.
      if (mode().squad) onFormUp?.(mode());
      resetFlags();
      startedAt = Date.now();
      world.beginRound?.(settings, mode());
      enter(PHASES.live, settings.roundSeconds);
      return true;
    },

    finish(reason = 'time') {
      if (phase !== PHASES.live) return false;
      results = buildResults({ world, mode: mode(), scores, settings, reason, startedAt });
      enter(PHASES.postgame);
      return true;
    },

    /** A kill happened. Only the mode decides whether that is worth anything. */
    onKill(victim, killer) {
      if (phase !== PHASES.live || !killer || killer === victim) return;
      const m = mode();
      if (!killer.team || killer.team === victim.team) return;

      if (m.id === 'tdm') scores[killer.team] += 1;
      if (m.id === 'commander') {
        // A squad fighter is worth a point; the mind running them is worth five.
        const worth = victim.participant.role === 'commander' ? m.commanderBounty : 1;
        scores[killer.team] += worth;
        if (worth > 1) {
          onEvent(`${killer.name} killed the enemy commander. ${TEAMS[killer.team].name} +${worth}.`, 'kill');
        }
      }
    },

    /**
     * Can this shot hurt this body? Team modes say no to your own side, so an
     * agent can fire past a teammate instead of having to walk around them.
     */
    canDamage(attacker, target) {
      if (!attacker || attacker === target) return true;
      if (!mode().teams) return true;
      return !attacker.team || attacker.team !== target.team;
    },

    /** Out of lives means out of the round - you watch the rest of it. */
    spendLife(participant) {
      if (phase !== PHASES.live) return { respawn: false, eliminated: false };
      // Endless lives means the open arena: no elimination, and the original
      // drop-in cooldowns rather than a round's quick respawn. `wait: null`
      // is what tells the world to use them.
      if (settings.lives <= 0) return { respawn: true, wait: null };

      participant.livesLeft = Math.max(0, (participant.livesLeft ?? settings.lives) - 1);
      if (participant.livesLeft > 0) return { respawn: true, wait: settings.respawnSeconds };

      participant.status = 'eliminated';
      onEvent(`${participant.name} is out of lives.`, 'kill');
      return { respawn: false, eliminated: true };
    },

    update(dt) {
      clock += dt;

      if (phase === PHASES.live) {
        stepFlags();
        // Nobody left standing on one side ends it early rather than running
        // the clock down on an empty arena.
        if (this.decided()) return void this.finish('eliminated');
      }

      if (limit && clock >= limit) {
        if (phase === PHASES.briefing) this.goLive();
        else if (phase === PHASES.live) this.finish('time');
      }
    },

    /** True when carrying on would not change the result. */
    decided() {
      // Waiting for a slot or a respawn still counts as being in the round.
      const standing = world.lobby.list().filter((p) => p.status !== 'eliminated' && p.status !== 'gone');
      if (!standing.length) return world.lobby.list().some((p) => p.status === 'eliminated');
      if (!mode().teams) return standing.length < 2 && world.lobby.list().length > 1;
      const sides = new Set(standing.map((p) => p.team));
      return sides.size < 2 && world.lobby.list().some((p) => p.status === 'eliminated');
    },

    /** Where a team's flag stands when it is at home. */
    baseFor(team) {
      return baseOf(team);
    },

    /** Only used by the host when a guest asks to be put on a side. */
    assign(participant, team) {
      participant.team = mode().teams ? (team === 'b' ? 'b' : 'a') : null;
      return participant.team;
    },

    /** Smallest side, so clicking "add bot" repeatedly stays even. */
    thinnestTeam() {
      if (!mode().teams) return null;
      const count = (t) => world.lobby.list().filter((p) => p.team === t && p.status !== 'gone').length;
      return count('a') <= count('b') ? 'a' : 'b';
    },

    /** Guests render from the host's word rather than running any of this. */
    applyState(state) {
      if (!state) return;
      const changed = state.phase !== phase;
      phase = state.phase;
      settings = { ...settings, ...state.settings };
      scores = { ...state.scores };
      results = state.results ?? null;
      // Seats arrive from the host and are only ever displayed here, so they
      // are reshaped rather than trusted.
      seats = {};
      for (const [id, seat] of Object.entries(state.seats ?? {})) {
        seats[String(id).slice(0, 64)] = {
          name: String(seat?.name ?? 'Someone').slice(0, 18),
          color: isHex(seat?.color) ? seat.color : '#8b93a7',
          side: seat?.side === 'a' || seat?.side === 'b' || seat?.side === 'play' ? seat.side : null,
          canPlay: seat?.canPlay !== false,
        };
      }
      limit = 0;
      if (state.flags) {
        flags ??= { a: { team: 'a' }, b: { team: 'b' } };
        for (const [key, value] of Object.entries(state.flags)) flags[key] = { ...flags[key], ...value };
      } else {
        flags = null;
      }
      setMap(settings.map);
      if (changed) onPhase(api.state);
    },

    /** Guests show the host's countdown without owning it. */
    setRemaining(seconds) {
      if (seconds === null || seconds === undefined) {
        limit = 0;
        return;
      }
      clock = 0;
      limit = seconds;
    },
  };

  return api;
}

function clampNumber(value, [lo, hi], fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * The scoreboard, the podium and the few lines of colour under them. Built once
 * when the round ends, from what the participants carried through it.
 */
export function buildResults({ world, mode, scores, settings, reason, startedAt }) {
  const rows = world.lobby.list()
    .filter((p) => p.status !== 'gone')
    .map((p) => ({
      id: p.id,
      name: p.name,
      colorIndex: p.colorIndex,
      team: p.team ?? null,
      // What a viewer needs to colour this row the way the arena coloured it.
      seat: p.seat ?? null,
      favColor: p.favColor ?? null,
      role: p.role ?? null,
      brainKind: p.brainKind,
      isMine: Boolean(p.isMine),
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists ?? 0,
      captures: p.captures ?? 0,
      returns: p.returns ?? 0,
      damageDealt: Math.round(p.damageDealt),
      damageTaken: Math.round(p.damageTaken),
      shotsFired: p.shotsFired,
      pelletsFired: p.pelletsFired ?? 0,
      hits: p.hits ?? 0,
      decisions: p.decisions,
      // `longestLife` is only written when a life ends, so somebody who was
      // never killed would otherwise read as nought seconds.
      longestLife: Math.round(Math.max(p.longestLife ?? 0, p.agent ? world.time - p.agent.spawnedAt : 0)),
      livesLeft: p.livesLeft ?? 0,
      accuracy: p.pelletsFired ? Math.round((p.hits / p.pelletsFired) * 100) : 0,
      score: mode.id === 'ctf' ? (p.captures ?? 0) : p.kills,
    }));

  // In a team mode the table is still ranked individually - it is the podium
  // that belongs to the side, and the scoreboard that belongs to the person.
  rows.sort((a, b) => b.score - a.score || b.kills - a.kills || b.damageDealt - a.damageDealt || a.name.localeCompare(b.name));

  let winner = null;
  let winningTeam = null;

  if (mode.teams) {
    winningTeam = scores.a === scores.b ? null : scores.a > scores.b ? 'a' : 'b';
    // The speech belongs to whoever did most for the winning side.
    winner = winningTeam ? rows.find((r) => r.team === winningTeam) ?? null : null;
  } else {
    // The table is already sorted by score, then kills, then damage. A winner
    // is whoever that leaves on top; it is only a draw when the top two are
    // identical on every one of those.
    const drawn = rows.length > 1 &&
      rows[0].score === rows[1].score &&
      rows[0].kills === rows[1].kills &&
      rows[0].damageDealt === rows[1].damageDealt;
    winner = rows.length && !drawn ? rows[0] : null;
  }

  const best = (key) => rows.reduce((top, row) => (!top || row[key] > top[key] ? row : top), null);
  const notable = [];
  const damage = best('damageDealt');
  const sharp = rows.filter((r) => r.pelletsFired >= 6).sort((a, b) => b.accuracy - a.accuracy)[0];
  const survivor = best('longestLife');
  const helper = best('assists');

  if (damage?.damageDealt) notable.push({ label: 'Most damage', name: damage.name, value: `${damage.damageDealt}` });
  if (sharp?.accuracy) notable.push({ label: 'Best accuracy', name: sharp.name, value: `${sharp.accuracy}%` });
  if (survivor?.longestLife) notable.push({ label: 'Longest life', name: survivor.name, value: `${survivor.longestLife}s` });
  if (helper?.assists) notable.push({ label: 'Most assists', name: helper.name, value: `${helper.assists}` });
  if (mode.id === 'ctf') {
    const returner = best('returns');
    if (returner?.returns) notable.push({ label: 'Most flag returns', name: returner.name, value: `${returner.returns}` });
  }

  return {
    mode: mode.id,
    modeName: mode.name,
    map: settings.map,
    reason,
    teams: mode.teams,
    scores: { ...scores },
    winningTeam,
    winner: winner ? { id: winner.id, name: winner.name, team: winner.team } : null,
    speech: null,                 // filled in when the winning agent answers
    podium: rows.slice(0, 3),
    rows,
    notable,
    playedSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
  };
}
