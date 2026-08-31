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

function join({ name, prompt, brainKind }) {
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
  ui.select(participant.id);

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
    join({ name: base, prompt: preset.prompt, brainKind: 'local' });
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
async function checkModelBackend() {
  // Opened straight off disk there is no server to ask, and attempting the
  // fetch only logs a CORS failure. Offline brains still work.
  if (!location.protocol.startsWith('http')) {
    brains.claude.markUnavailable();
    ui.setModelBadge('off', 'Claude off · run the server to enable it');
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
      ui.setModelBadge('off', data.reason ?? 'Claude off');
    }
  } catch {
    brains.claude.markUnavailable();
    ui.setModelBadge('off', 'Claude off · offline brains only');
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

  // The panel does not need 60 Hz.
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
