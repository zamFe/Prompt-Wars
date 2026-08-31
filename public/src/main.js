// Entry point: builds the world, wires the UI, runs the loop.

import { World } from './world.js';
import { createParticipant } from './lobby.js';
import { createBrains } from './brains/index.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';
import { PRESETS, DEMO_NAMES } from './presets.js';
import { AGENT_COLORS, WORLD } from './config.js';

const brains = createBrains();
const world = new World({ brains });
const renderer = new Renderer(document.getElementById('arena'));

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

function join({ name, prompt, brainKind, focus = true }) {
  if (!name) return { ok: false, message: 'Give your agent a name.', tone: 'bad' };
  if (prompt.length < 12) {
    return { ok: false, message: 'Write a real prompt — at least a sentence of tactics.', tone: 'bad' };
  }
  if (brainKind === 'claude' && !brains.claude.available) {
    return { ok: false, message: 'The live model backend is not available. Use the offline interpreter.', tone: 'bad' };
  }

  const participant = createParticipant({
    name: uniqueName(name.slice(0, 14)),
    prompt,
    brainKind,
    colorIndex: pickColorIndex(),
  });

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
    join({ name: base, prompt: preset.prompt, brainKind: 'local', focus: false });
  }
}

function clearArena() {
  for (const participant of world.lobby.list()) world.lobby.remove(participant.id);
  world.projectiles = [];
  world.pickups = [];
  world.effects = [];
  world.log = [];
  usedColors = new Set();
  usedNames = new Set();
  ui.selectedId = null;
  world.addLog('Arena cleared.', 'info');
}

const ui = new UI({
  world,
  onJoin: join,
  onDemo: () => addDemoAgents(4),
  onClear: clearArena,
  onSelect: () => ui.update(),
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

// ---------------------------------------------------------------- input
renderer.canvas.addEventListener('click', (event) => {
  const point = renderer.toWorld(event.clientX, event.clientY);
  ui.selectByPoint(point.x, point.y);
});

window.addEventListener('resize', () => renderer.resize());

// ---------------------------------------------------------------- main loop
const STEP = 1 / WORLD.tickRate;
let accumulator = 0;
let previous = performance.now();
let uiClock = 0;

function frame(now) {
  const elapsed = Math.min(0.25, (now - previous) / 1000);
  previous = now;
  accumulator += elapsed;

  let guard = 0;
  while (accumulator >= STEP && guard++ < 8) {
    world.update(STEP);
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
