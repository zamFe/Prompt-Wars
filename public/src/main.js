// Entry point: builds the world, wires the UI, runs the loop.

import { World } from './world.js';
import { createParticipant } from './lobby.js';
import { createBrains, createRemoteBrain, DEFAULT_TIER } from './brains/index.js';
import { createUsageMeter } from './usage.js';
import { createNet, TOPICS } from './net.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';
import { PRESETS, DEMO_NAMES } from './presets.js';
import { AGENT_COLORS, WORLD } from './config.js';
import { createChatLog, createDirectLog } from './chatlog.js';
import { messageAgent } from './comms.js';
import { createMatch, PHASES, MODES, CODENAMES } from './match.js';
import { createScreens } from './screens.js';

const usage = createUsageMeter({ onChange: (state) => ui?.renderUsage(state) });
const brains = createBrains({ usage });
const world = new World({ brains });

// The match owns the phase, the rules and the clock; the world owns the bodies.
const match = createMatch({
  world,
  onPhase: (state) => onPhaseChanged(state),
  onEvent: (text, kind) => world.addLog(text, kind ?? 'info'),
  onFormUp: (mode) => raiseSquads(mode),
});
world.match = match;
// Nothing enters the arena until a round is actually being fought. The World's
// own default is open, for the tests and for anyone using it without a match.
world.allowSpawning = false;
const renderer = new Renderer(document.getElementById('arena'));
const chatLog = createChatLog();
// The private channel. It has its own store because it has its own audience:
// nobody. Messages here never reach the server, the room or another viewer.
const directLog = createDirectLog();

// Every bubble the world raises is mirrored into the global history...
world.onSay = (agent, text) => chatLog.record(agent, text);
// ...while a private answer goes only into this page's own thread.
world.onReply = (agent, text) =>
  directLog.post({ side: 'agent', participant: agent.participant, name: agent.name, color: agent.color, text });

/**
 * Hand a line to one of my own agents. The message waits in that agent's inbox
 * until its next decision, which is the only place it enters the conversation -
 * so it costs no extra model call. Whatever is still queued is dropped so the
 * answer does not have to wait out a four-action plan.
 */
function deliver(participant, text) {
  if (!participant?.isMine) return null;
  const line = messageAgent(participant, text);
  if (!line) return null;
  directLog.post({ side: 'you', participant, name: 'You', text: line });
  if (participant.agent) world.nudge(participant.agent);
  return line;
}

let usedColors = new Set();
let usedNames = new Set();

/** Every agent gets a random sphere colour, avoiding repeats while it can. */
function pickColorIndex() {
  const free = AGENT_COLORS.map((_, i) => i).filter((i) => !usedColors.has(i));
  const pool = free.length ? free : AGENT_COLORS.map((_, i) => i);
  const index = pool[Math.floor(Math.random() * pool.length)];
  usedColors.add(index);
  return index;
}

function uniqueName(base) {
  let name = base;
  let n = 2;
  while (usedNames.has(name.toLowerCase())) name = `${base}${n++}`;
  usedNames.add(name.toLowerCase());
  return name;
}

function join({ name, prompt, brainKind, tier, team = null, role = null, focus = true, ownerPeer = null, ownerId = null, mine = true }) {
  if (!name) return { ok: false, message: 'Give your agent a name.', tone: 'bad' };
  if (prompt.length < 12) {
    return { ok: false, message: 'Write a real prompt — at least a sentence of tactics.', tone: 'bad' };
  }
  if (brainKind === 'claude' && !brains.claude.available) {
    return { ok: false, message: 'The server backend is not available. Use the offline interpreter.', tone: 'bad' };
  }
  if (brainKind === 'sample' && !brains.sample.available) {
    return { ok: false, message: 'Claude is not available in this view. Use the offline interpreter.', tone: 'bad' };
  }
  if (brainKind === 'sample' && usage.state.exhausted) {
    return { ok: false, message: 'Call budget spent. Raise it, or deploy on the offline interpreter.', tone: 'bad' };
  }

  // Commander mode is one agent a side. A commander takes a free chair or is
  // turned away; the squads it is given are not commanders and skip all this.
  let side = team;
  if (match.mode.squad && role !== 'squad') {
    const free = match.freeCommandSlot();
    side = team && free !== null ? team : free;
    if (!side) {
      return { ok: false, message: 'Both commander slots are taken — this mode is one agent a side.', tone: 'bad' };
    }
  }

  const participant = createParticipant({
    name: uniqueName(name.slice(0, 14)),
    prompt,
    brainKind,
    colorIndex: pickColorIndex(),
  });
  participant.tier = tier ?? DEFAULT_TIER;
  // In a team mode a fighter joins whichever side is thinner, unless the owner
  // has already put them somewhere.
  participant.team = side ?? match.thinnestTeam();
  participant.role = role ?? (match.mode.squad ? 'commander' : null);
  participant.ownerPeer = ownerPeer;
  participant.ownerId = ownerId;
  // Agents I deployed: only these may lock my tier selector or bill my account.
  participant.isMine = mine;

  if (mine && !net?.isHost && net?.state.available) {
    // Someone else is simulating: ask them to put this agent in.
    net.send(TOPICS.join, { name: participant.name, prompt, tier: participant.tier });
    world.lobby.participants.set(participant.id, participant);
    participant.status = 'queued';
    return { ok: true, message: `${participant.name} sent to the host.`, tone: 'ok' };
  }

  const outcome = world.lobby.add(participant);
  // Deploying your own agent follows it in the focus bar. Filler agents must
  // not steal that focus back.
  if (focus) ui.focus(participant.id);
  screens.renderLobby();
  ui.renderChat();

  if (match.phase === PHASES.briefing) {
    return { ok: true, message: `${participant.name} is ready. The round starts when the clock runs out.`, tone: 'ok' };
  }
  return outcome === 'spawned'
    ? { ok: true, message: `${participant.name} is in the arena.`, tone: 'ok' }
    : {
        ok: true,
        message: `Arena is full — ${participant.name} is #${world.lobby.queuePosition(participant.id)} in the queue.`,
        tone: 'warn',
      };
}

/** A squad fighter's standing orders, before its commander says anything. */
const SQUAD_PROMPT =
  'You are a squad fighter under a commander. Move with purpose, engage what you can see, take cover when you ' +
  'are hurt, and above all do what your commander tells you the moment they tell you.';

/**
 * Raise four bots for every commander, with call-signs.
 *
 * Built fresh each round: last round's squad is gone, and a commander should
 * never inherit a fighter it was not briefed on.
 */
function raiseSquads(mode) {
  for (const participant of world.lobby.list()) {
    if (participant.role === 'squad') world.lobby.remove(participant.id);
  }

  const commanders = Object.values(match.trimToCommanders()).filter(Boolean);
  for (const commander of commanders) {
    const team = commander.team ?? 'a';
    const names = CODENAMES[team] ?? CODENAMES.a;
    const codenames = names.slice(0, mode.squad);

    for (const codename of codenames) {
      const result = join({
        name: codename,
        prompt: SQUAD_PROMPT,
        brainKind: 'local',
        team,
        role: 'squad',
        focus: false,
        mine: false,
      });
      if (!result.ok) continue;

      // The newest participant is the one just added.
      const bot = world.lobby.list().at(-1);
      bot.codename = codename;
      bot.commanderId = commander.id;
      bot.commanderName = commander.name;
      bot.squadCodenames = codenames;
    }
  }
  screens.renderLobby();
}

function addDemoAgents(count = 4, team = null) {
  for (let i = 0; i < count; i++) {
    const preset = PRESETS[Math.floor(Math.random() * PRESETS.length)];
    const base = DEMO_NAMES[Math.floor(Math.random() * DEMO_NAMES.length)];
    join({ name: base, prompt: preset.prompt, brainKind: 'local', focus: false, mine: false, team });
  }
}

function clearArena() {
  world.clearArena();
  world.log = [];
  world.champions = [];
  usedColors = new Set();
  usedNames = new Set();
  ui.selectedId = null;
  // Those agents are gone, and so are the channels to them.
  directLog.clear();
  world.addLog('Arena cleared.', 'info');
  screens.renderLobby();
}

const ui = new UI({
  world,
  match,
  chatLog,
  directLog,
  onJoin: join,
  onMessage: deliver,
  onSkipBrief: () => {
    if (!role.canEdit) return;
    if (net?.state.available && !net.isHost) return net.send(TOPICS.setup, { go: true });
    match.goLive();
  },
  onDemo: () => {
    if (net?.state.available && !net.isHost) return net.send(TOPICS.bots, { count: 4 });
    addDemoAgents(4);
  },
  onClear: () => {
    if (net?.state.available && !net.isHost) return net.send(TOPICS.clear, {});
    clearArena();
  },
  onSelect: () => {
    ui.applyChatFocus();
    ui.update();
  },
  onTogglePause: () => {
    world.paused = !world.paused;
    return world.paused;
  },
});

// Who is at the keyboard. Resolved below once the viewer answers; until then a
// page running on its own is its own owner.
let role = { isOwner: true, canEdit: true, known: false };

// The lobby, the title card and the post-game report. Everything that changes
// the shared game is the owner's, and goes through the host.
const screens = createScreens({
  world,
  match,
  onConfigure: (patch) => {
    if (!role.canEdit) return;
    if (net?.state.available && !net.isHost) return net.send(TOPICS.setup, { settings: patch });
    match.configure(patch);
    screens.renderLobby();
  },
  onAddBot: () => {
    if (!role.canEdit) return;
    if (net?.state.available && !net.isHost) return net.send(TOPICS.bots, { count: 1 });
    // Commander mode is one agent a side: a bot here is an opposing commander,
    // and its squad is raised for it when the round starts.
    if (match.mode.squad) {
      const free = match.freeCommandSlot();
      if (!free) return;                     // both chairs are full
      addDemoAgents(1, free);
      screens.renderLobby();
      return;
    }
    addDemoAgents(1, match.thinnestTeam());
  },
  onClearLobby: () => {
    if (!role.canEdit) return;
    if (net?.state.available && !net.isHost) return net.send(TOPICS.clear, {});
    clearArena();
  },
  onStart: () => {
    if (!role.canEdit) return;
    if (net?.state.available && !net.isHost) return net.send(TOPICS.setup, { start: true });
    match.openBriefing();
  },
  onReturn: () => {
    if (!role.canEdit) return;
    if (net?.state.available && !net.isHost) return net.send(TOPICS.setup, { lobby: true });
    match.toLobby();
  },
  onSetTeam: (participantId, team) => {
    if (!role.canEdit) return;
    if (net?.state.available && !net.isHost) return net.send(TOPICS.setup, { team: { id: participantId, team } });
    const participant = world.lobby.get(participantId);
    if (participant) match.assign(participant, team);
    screens.renderLobby();
  },
});

/**
 * One phase change, one place. Bodies only exist while a round is being
 * fought, the canvas is only sized when it is actually on screen, and the
 * host tells everyone else what just happened.
 */
function onPhaseChanged(state) {
  world.allowSpawning = state.phase === PHASES.live;
  screens.render();
  ui.renderMatch();
  // The mode decides whether the second card is a global channel or your own
  // side's, so it is re-read whenever the round changes shape.
  ui.renderChat();

  if (state.phase === PHASES.live || state.phase === PHASES.briefing) {
    // The canvas was display:none a moment ago, so it has no size yet.
    requestAnimationFrame(() => renderer.resize());
  }
  if (state.phase === PHASES.postgame) askForVictorySpeech();
  if (net?.isHost) net.send(TOPICS.phase, match.state);
}

// --------------------------------------------------------------- model check
const REPO = 'https://github.com/zamFe/Prompt-Wars';

// This page is a single static file. There is no server behind it to hold an
// API key, so agents here run on the offline interpreter - which is genuinely
// prompt-driven, and the whole game works.
const NO_SERVER_HINT =
  `Agents here run on the <b>offline interpreter</b> — it reads your prompt for intent, ` +
  `so everything on this page works. Live model agents need the server, which holds the key: ` +
  `<a href="${REPO}" target="_blank" rel="noopener">clone the repo</a> and run <code>npm start</code>. ` +
  `It also ships a free offline stub model (<code>npm run stub-model</code>), and works against a local ` +
  `model through any Messages-compatible gateway.`;

const NO_CREDENTIALS_HINT =
  `The server is running but has no working credentials. Set <code>ANTHROPIC_API_KEY</code>, or try the ` +
  `free routes: <code>npm run stub-model</code>, or point <code>ANTHROPIC_BASE_URL</code> at a local model ` +
  `with <code>PROMPT_WARS_COMPAT=1</code>.`;
async function checkModelBackend() {
  // Opened straight off disk there is no server to ask, and attempting the
  // fetch only logs a CORS failure. Offline brains still work.
  if (!location.protocol.startsWith('http')) {
    brains.claude.markUnavailable();
    ui.setModelBadge('off', 'Offline brain · no server behind this page', { hint: NO_SERVER_HINT });
    return;
  }

  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    if (data.ready) {
      // In compatibility mode something other than Claude is answering, so name
      // the model rather than claiming a provider.
      ui.setModelBadge('ok', data.compat ? `Model ready · ${data.model}` : `Claude ready · ${data.model}`, { compat: data.compat });
    } else {
      brains.claude.markUnavailable();
      ui.setModelBadge('off', data.reason ?? 'Claude off', { hint: NO_CREDENTIALS_HINT });
    }
  } catch {
    brains.claude.markUnavailable();
    ui.setModelBadge('off', 'Offline brain · server unreachable', { hint: NO_SERVER_HINT });
  }
}
checkModelBackend();

// ------------------------------------------------------- Claude, this viewer's
// `sample` spends the viewer's own Claude usage, so it is offered only once the
// runtime has actually handed it over.
brains.sample.ready.then(() => {
  const option = ui.el.brain.querySelector('option[value="sample"]');
  if (brains.sample.available) {
    option.disabled = false;
    ui.el.brain.value = 'sample';
    ui.setModelBadge('ok', 'Claude · your account');
    ui.renderUsage(usage.state);
  } else {
    option.disabled = true;
    option.textContent = 'Claude — not available here';
  }
  ui.syncTierRow();
});

// ------------------------------------------------------------------ the room
const net = createNet({
  world,
  makeGhost,
  onState: (state) => {
    ui.renderRoom(state);
    screens.setRoom(state);
    // A guest never simulates: it renders what the host sends.
    simulating = state.isHost;
  },
});

world.brains.remote = createRemoteBrain({ net, fallback: brains.local });

/** A body a guest renders but does not own. */
function makeGhost(netId) {
  const participant = createParticipant({ name: '…', prompt: '', brainKind: 'remote', colorIndex: netId });
  participant.isMine = false;
  world.lobby.participants.set(participant.id, participant);
  const agent = {
    id: `ghost${netId}`, netId, participant, name: '…',
    color: AGENT_COLORS[netId % AGENT_COLORS.length],
    x: 0, y: 0, facing: 0, aimOffset: 0, hp: 100, alive: true,
    weapon: 'pistol', ammo: 3, nextShotAt: 0, reloadUntil: 0, spawnProtectedUntil: 0,
    queue: [], current: null, thinking: false, pendingEvents: [], planResults: [],
    lastActions: [], lastRefused: [], pulses: { fire: -Infinity, reload: -Infinity, hurt: -Infinity, heal: -Infinity, kill: -Infinity, pickup: -Infinity },
    recentDamage: new Map(), lifeKills: 0, lifeAssists: 0, chat: null, lastReply: null, heard: [], spawnedAt: 0,
  };
  participant.agent = agent;
  return agent;
}

// As host: take in players who deployed from another page.
net.onJoinRequest = (data, msg) => {
  if (!net.isHost || !data?.prompt) return;
  join({
    name: String(data.name ?? 'Guest').slice(0, 14),
    prompt: String(data.prompt).slice(0, 1200),
    brainKind: 'remote',
    tier: data.tier,
    focus: false,
    mine: false,
    ownerPeer: msg.peer,
    ownerId: msg.by ?? null,
  });
};

// As a player: my agent's turn to think, on my account.
net.onDecisionNeeded = async (request) => {
  if (!request?.id) return;
  const participant = world.lobby.list().find((p) => p.isMine && p.name === request.name);
  if (!participant) return;
  try {
    const decision = await brains.sample.decideForOwned(request, participant);
    // A private answer stays here: it is shown in my own agent chat and is
    // deliberately left out of the plan that goes to the host.
    if (decision?.reply) {
      directLog.post({
        side: 'agent',
        participant,
        name: participant.name,
        color: AGENT_COLORS[participant.colorIndex % AGENT_COLORS.length],
        text: decision.reply,
      });
    }
    net.send(TOPICS.plan, {
      id: request.id,
      actions: decision?.actions ?? [],
      chat: decision?.chat ?? null,
      note: decision?.note ?? null,
    });
  } catch {
    net.send(TOPICS.plan, { id: request.id, actions: [] });
  }
};

// Admin-only topics: the platform refuses these from anyone below Editor, so
// the gate is enforced there and not merely hidden in this page.
net.onBotsRequest = (data) => {
  if (net.isHost) addDemoAgents(Math.min(6, Math.max(1, Number(data?.count) || 4)));
};
net.onClearRequest = () => {
  if (net.isHost) clearArena();
};

// Guests follow the host's phase, score and clock rather than running any of
// it themselves.
net.onPhase = (state) => {
  if (net.isHost) return;
  match.applyState(state);
  match.setRemaining(state?.remaining ?? null);
  screens.render();
  ui.renderMatch();
};

// Everything the owner decides in the lobby arrives here, on a topic the
// platform already refuses from anyone below Editor.
net.onSetupRequest = (data) => {
  if (!net.isHost || !data) return;
  if (data.settings) match.configure(data.settings);
  if (data.team?.id) {
    const participant = world.lobby.get(data.team.id);
    if (participant) match.assign(participant, data.team.team);
  }
  if (data.start) match.openBriefing();
  if (data.go) match.goLive();
  if (data.lobby) match.toLobby();
  screens.renderLobby();
  net.send(TOPICS.phase, match.state);
};

net.connect().then((joined) => {
  if (joined) {
    ui.renderRoom(net.state);
    screens.setRoom(net.state);
    // A page that joins late, or misses a message, is never more than a beat
    // behind: the host repeats where everyone is once a second.
    setInterval(() => {
      if (net.isHost) net.send(TOPICS.phase, match.state);
    }, 1000);
  }
});

// --------------------------------------------------------------- who is here
// Owner, Editor, Contributor and Viewer are different things on an artifact,
// and the controls that change the shared arena belong to the first two.
(async () => {
  let resolved = { isOwner: false, canEdit: false, known: false };
  try {
    const user = await globalThis.claude?.use?.('user');
    if (user) {
      const [isOwner, canEdit] = await Promise.all([user.isOwner(), user.canEdit()]);
      resolved = { isOwner, canEdit, known: true };
    }
  } catch {
    // No viewer to ask: treat this as a page running on its own.
  }
  // Opened outside a viewer there is nobody to be below, so nothing is hidden.
  role = resolved.known ? resolved : { isOwner: true, canEdit: true, known: false };
  ui.setRole(role);
  screens.setRole(role);
})();

/**
 * The round is over and somebody won it. Ask that agent - not the page, the
 * agent - for a line, on its own account, and put it on the podium.
 */
async function askForVictorySpeech() {
  const results = match.results;
  if (!results?.winner || results.speech) return;
  const participant = world.lobby.get(results.winner.id);
  if (!participant) return;

  const brain = world.brains[participant.brainKind] ?? world.brains.local;
  try {
    const line = await (brain.victorySpeech?.(participant, results) ?? world.brains.local.victorySpeech(participant, results));
    if (!line || match.phase !== PHASES.postgame) return;
    results.speech = line;
    screens.renderPostgame();
    if (net?.isHost) net.send(TOPICS.phase, match.state);
  } catch {
    // A winner with nothing to say is not a broken game.
  }
}

// The comms history lives on the server when there is one, so it survives a
// reload; a static page keeps the same store in memory instead.
chatLog.connect().then(() => {
  chatLog.startPolling();
  ui.renderChat();
});

// ---------------------------------------------------------------- input
renderer.canvas.addEventListener('click', (event) => {
  const point = renderer.toWorld(event.clientX, event.clientY);
  ui.selectByPoint(point.x, point.y);
});

window.addEventListener('resize', () => renderer.resize());

// ---------------------------------------------------------------- main loop
const STEP = 1 / WORLD.tickRate;
// Host pages run the physics; guests render the host's word.
let simulating = true;
let accumulator = 0;
let previous = performance.now();
let uiClock = 0;

function frame(now) {
  const elapsed = Math.min(0.25, (now - previous) / 1000);
  previous = now;
  accumulator += elapsed;

  // The match clock runs in every phase - that is what makes the briefing
  // count down. Only the host advances it; a guest is told where it is.
  if (simulating) match.update(elapsed);

  let guard = 0;
  while (accumulator >= STEP && guard++ < 8) {
    if (simulating && match.phase === PHASES.live) world.update(STEP);
    accumulator -= STEP;
  }

  renderer.draw(world, { selectedId: ui.selectedId, match });

  // The focus bar carries sub-second action flashes, so it tracks the frame
  // rate; it diffs every field, so an unchanged frame writes no DOM at all.
  ui.renderFocusBar();
  ui.renderMatch();

  // The heavier panels do not need 60 Hz.
  uiClock += elapsed;
  if (uiClock >= 0.2) {
    uiClock = 0;
    ui.update();
  }

  requestAnimationFrame(frame);
}

// Nothing is in the arena, and nothing happens, until someone presses a key on
// the title card and sets a game up.
ui.update();
screens.render();
requestAnimationFrame(frame);

// Handy for poking at the simulation from the console.
window.promptWars = { world, match, brains, ui, screens, renderer, join, addDemoAgents, clearArena, deliver, directLog, chatLog };
