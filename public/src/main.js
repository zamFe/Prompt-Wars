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
import { createChatLog } from './chatlog.js';

const usage = createUsageMeter({ onChange: (state) => ui?.renderUsage(state) });
const brains = createBrains({ usage });
const world = new World({ brains });
const renderer = new Renderer(document.getElementById('arena'));
const chatLog = createChatLog();

// Every bubble the world raises is mirrored into the comms history.
world.onSay = (agent, text) => chatLog.record(agent, text);

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

function join({ name, prompt, brainKind, tier, focus = true, ownerPeer = null, ownerId = null, mine = true }) {
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

  const participant = createParticipant({
    name: uniqueName(name.slice(0, 14)),
    prompt,
    brainKind,
    colorIndex: pickColorIndex(),
  });
  participant.tier = tier ?? DEFAULT_TIER;
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

  return outcome === 'spawned'
    ? { ok: true, message: `${participant.name} is in the arena.`, tone: 'ok' }
    : {
        ok: true,
        message: `Arena is full — ${participant.name} is #${world.lobby.queuePosition(participant.id)} in the queue.`,
        tone: 'warn',
      };
}

function addDemoAgents(count = 4) {
  for (let i = 0; i < count; i++) {
    const preset = PRESETS[Math.floor(Math.random() * PRESETS.length)];
    const base = DEMO_NAMES[Math.floor(Math.random() * DEMO_NAMES.length)];
    join({ name: base, prompt: preset.prompt, brainKind: 'local', focus: false, mine: false });
  }
}

function clearArena() {
  for (const participant of world.lobby.list()) world.lobby.remove(participant.id);
  world.projectiles = [];
  world.pickups = [];
  world.effects = [];
  world.log = [];
  world.champions = [];
  usedColors = new Set();
  usedNames = new Set();
  ui.selectedId = null;
  world.addLog('Arena cleared.', 'info');
}

const ui = new UI({
  world,
  chatLog,
  onJoin: join,
  onDemo: () => addDemoAgents(4),
  onClear: clearArena,
  onSelect: () => {
    ui.applyChatFocus();
    ui.update();
  },
  onTogglePause: () => {
    world.paused = !world.paused;
    return world.paused;
  },
});

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
    recentDamage: new Map(), lifeKills: 0, lifeAssists: 0, chat: null, spawnedAt: 0,
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
    net.send(TOPICS.plan, { id: request.id, ...decision });
  } catch {
    net.send(TOPICS.plan, { id: request.id, actions: [] });
  }
};

net.connect().then((joined) => {
  if (joined) ui.renderRoom(net.state);
});

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

  let guard = 0;
  while (accumulator >= STEP && guard++ < 8) {
    if (simulating) world.update(STEP);
    accumulator -= STEP;
  }

  renderer.draw(world, { selectedId: ui.selectedId });

  // The focus bar carries sub-second action flashes, so it tracks the frame
  // rate; it diffs every field, so an unchanged frame writes no DOM at all.
  ui.renderFocusBar();

  // The heavier panels do not need 60 Hz.
  uiClock += elapsed;
  if (uiClock >= 0.2) {
    uiClock = 0;
    ui.update();
  }

  requestAnimationFrame(frame);
}

addDemoAgents(4);
ui.update();
requestAnimationFrame(frame);

// Handy for poking at the simulation from the console.
window.promptWars = { world, brains, ui, renderer, join, addDemoAgents, clearArena };
