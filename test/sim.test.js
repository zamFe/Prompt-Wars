// Headless rule tests. The simulation has no DOM dependencies, so the whole
// arena runs in Node.
//
//   node test/sim.test.js

import assert from 'node:assert/strict';

import { World } from '../public/src/world.js';
import { createParticipant } from '../public/src/lobby.js';
import { createLocalBrain, parsePrompt } from '../public/src/brains/local.js';
import { buildSnapshot } from '../public/src/sensors.js';
import { normalizeAction, buildQueue, stepAction, describeAction, MOVE_DIRECTIONS, TOOL_SCHEMAS, TOOL_NAMES, TOOL_SUMMARIES } from '../public/src/actions.js';
import { hasLineOfSight, castRay, clearance, resolveCollision } from '../public/src/arena.js';
import { WEAPONS, AGENT, WORLD, LOBBY, VISION, MOVE, CHAT, PULSE, HARD_RULES } from '../public/src/config.js';
import { extractChat, wrapChat, tidy } from '../public/src/chat.js';
import { parseConstraints, enforce, violation, hasConstraints, describeConstraints } from '../public/src/constraints.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

/** A world with an instant brain, so tests are deterministic and fast. */
function makeWorld(decide = () => ({ actions: [] })) {
  const brain = { id: 'test', decide: async (s, p) => decide(s, p) };
  return new World({ seed: 12345, brains: { local: brain, claude: brain } });
}

function addAgent(world, name, overrides = {}) {
  const participant = createParticipant({ name, prompt: 'hold still', brainKind: 'local', colorIndex: 0 });
  world.lobby.add(participant);
  Object.assign(participant.agent ?? {}, overrides);
  return participant;
}

console.log('\n-- weapon balance ------------------------------------------------');

test('pistol takes 5 hits to kill a full-health agent', () => {
  assert.equal(Math.ceil(AGENT.maxHp / WEAPONS.pistol.damage), 5);
});

test('assault rifle takes 7 hits, and out-damages the pistol over time', () => {
  assert.equal(Math.ceil(AGENT.maxHp / WEAPONS.assault.damage), 7);
  const dps = (w) => (w.magazine * w.damage * w.pellets) / (w.magazine * w.timeBetweenShots + w.reloadTime);
  assert.ok(dps(WEAPONS.assault) > dps(WEAPONS.pistol) * 1.3,
    `assault ${dps(WEAPONS.assault).toFixed(1)} dps vs pistol ${dps(WEAPONS.pistol).toFixed(1)}`);
});

test('point-blank shotgun kills in 3 shells but not 2', () => {
  const burst = WEAPONS.shotgun.damage * WEAPONS.shotgun.pellets;
  assert.ok(burst * 2 < AGENT.maxHp * 1.1, 'two shells should not comfortably one-burst');
  assert.ok(burst * 3 > AGENT.maxHp, 'three shells should kill');
});

test('shotgun damage falls off past its falloff start', () => {
  const w = WEAPONS.shotgun;
  assert.ok(w.falloffFloor < 1, 'shotgun must lose damage at range');
  const far = w.damage * w.pellets * w.falloffFloor;
  assert.ok(far < WEAPONS.pistol.damage * 1.2, `far shotgun burst ${far} should be weak`);
});

test('both pickup weapons beat the default pistol on sustained damage', () => {
  const dps = (w) => (w.magazine * w.damage * w.pellets) / (w.magazine * w.timeBetweenShots + w.reloadTime);
  assert.ok(dps(WEAPONS.shotgun) > dps(WEAPONS.pistol));
  assert.ok(dps(WEAPONS.assault) > dps(WEAPONS.pistol));
});

console.log('\n-- arena geometry ------------------------------------------------');

test('walls block line of sight', () => {
  assert.equal(hasLineOfSight(700, 500, 700, 900), false, 'centre bar should block');
  assert.equal(hasLineOfSight(150, 200, 150, 1200), true, 'open lane should not block');
});

test('rays stop at the arena border', () => {
  assert.ok(castRay(700, 700, 1, 0, 5000) < WORLD.size, 'ray must not escape the arena');
});

test('collision ejects a body out of a wall', () => {
  const fixed = resolveCollision(700, 700, WORLD.agentRadius);
  assert.ok(fixed.blocked);
  assert.ok(clearance(fixed.x, fixed.y) >= WORLD.agentRadius - 0.5,
    `ejected to clearance ${clearance(fixed.x, fixed.y)}`);
});

console.log('\n-- vision --------------------------------------------------------');

test('an agent sees a target inside its cone and not one behind it', () => {
  const world = makeWorld();
  const a = addAgent(world, 'A');
  const b = addAgent(world, 'B');
  Object.assign(a.agent, { x: 200, y: 200, facing: 0 });     // facing east
  Object.assign(b.agent, { x: 500, y: 200 });                 // directly east

  assert.equal(buildSnapshot(a.agent, world).enemies.length, 1, 'should see target ahead');

  a.agent.facing = 180;                                       // now facing west
  assert.equal(buildSnapshot(a.agent, world).enemies.length, 0, 'should not see behind');
});

test('vision does not reach through a wall', () => {
  const world = makeWorld();
  const a = addAgent(world, 'A');
  const b = addAgent(world, 'B');
  Object.assign(a.agent, { x: 700, y: 500, facing: 90 });      // facing south at the centre bar
  Object.assign(b.agent, { x: 700, y: 900 });                  // behind it
  assert.equal(buildSnapshot(a.agent, world).enemies.length, 0);
});

test('the cone is the configured width', () => {
  const world = makeWorld();
  const a = addAgent(world, 'A');
  const b = addAgent(world, 'B');
  Object.assign(a.agent, { x: 200, y: 700, facing: 0 });
  const half = VISION.fov / 2;

  // Just inside the cone edge, far enough out that the body does not clip it.
  const inside = (half - 3) * (Math.PI / 180);
  Object.assign(b.agent, { x: 200 + Math.cos(inside) * 500, y: 700 + Math.sin(inside) * 500 });
  assert.equal(buildSnapshot(a.agent, world).enemies.length, 1, 'inside the cone');

  const outside = (half + 8) * (Math.PI / 180);
  Object.assign(b.agent, { x: 200 + Math.cos(outside) * 500, y: 700 + Math.sin(outside) * 500 });
  assert.equal(buildSnapshot(a.agent, world).enemies.length, 0, 'outside the cone');
});

test('snapshots report relative position only, never arena coordinates', () => {
  const world = makeWorld();
  const a = addAgent(world, 'A');
  const b = addAgent(world, 'B');
  // A lane with no cover in it, so the test measures the snapshot and not the walls.
  Object.assign(a.agent, { x: 300, y: 180, facing: 0 });
  Object.assign(b.agent, { x: 700, y: 180 });

  const snapshot = buildSnapshot(a.agent, world);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!('x' in snapshot.self) && !('y' in snapshot.self), 'self must not expose coordinates');
  assert.ok(!serialized.includes('"x"'), 'snapshot must not contain any x coordinate');
  assert.equal(snapshot.enemies[0].distance, 400);
  assert.equal(snapshot.enemies[0].bearing, 0);
  assert.equal(snapshot.walls.cone.length, VISION.wallRays);
});

console.log('\n-- bullets -------------------------------------------------------');

test('a bullet damages a target in the open', () => {
  const world = makeWorld();
  const a = addAgent(world, 'A');
  const b = addAgent(world, 'B');
  Object.assign(a.agent, { x: 200, y: 700, facing: 0, aimOffset: 0, weapon: 'pistol', ammo: 3, spawnProtectedUntil: 0 });
  Object.assign(b.agent, { x: 400, y: 700, spawnProtectedUntil: 0 });

  world.fireWeapon(a.agent);
  for (let i = 0; i < 60; i++) world.stepProjectiles(1 / 60);
  assert.ok(b.agent.hp < AGENT.maxHp, `expected damage, hp is ${b.agent.hp}`);
});

test('a wall stops a bullet before it reaches a target behind it', () => {
  const world = makeWorld();
  const a = addAgent(world, 'A');
  const b = addAgent(world, 'B');
  Object.assign(a.agent, { x: 700, y: 500, facing: 90, aimOffset: 0, weapon: 'pistol', ammo: 3, spawnProtectedUntil: 0 });
  Object.assign(b.agent, { x: 700, y: 900, spawnProtectedUntil: 0 });

  world.fireWeapon(a.agent);
  for (let i = 0; i < 60; i++) world.stepProjectiles(1 / 60);
  assert.equal(b.agent.hp, AGENT.maxHp, 'target behind cover must be untouched');
});

test('spawn protection absorbs damage', () => {
  const world = makeWorld();
  const a = addAgent(world, 'A');
  const b = addAgent(world, 'B');
  Object.assign(a.agent, { x: 200, y: 700, facing: 0, weapon: 'pistol', ammo: 3, spawnProtectedUntil: 0 });
  Object.assign(b.agent, { x: 400, y: 700, spawnProtectedUntil: world.time + 5 });

  world.fireWeapon(a.agent);
  for (let i = 0; i < 60; i++) world.stepProjectiles(1 / 60);
  assert.equal(b.agent.hp, AGENT.maxHp);
});

console.log('\n-- lobby, queue and death timers ---------------------------------');

test('the arena holds ten agents and queues the rest', () => {
  const world = makeWorld();
  for (let i = 0; i < 14; i++) addAgent(world, `A${i}`);
  assert.equal(world.agents.length, WORLD.maxAgents);
  assert.equal(world.lobby.queue.length, 4);
  assert.equal(world.lobby.queuePosition(world.lobby.queue[0]), 1);
});

test('a death frees a slot and the queue fills it', () => {
  const world = makeWorld();
  for (let i = 0; i < 12; i++) addAgent(world, `A${i}`);
  const waiting = world.lobby.queue[0];
  world.killAgent(world.agents[0], null);
  assert.equal(world.agents.length, WORLD.maxAgents, 'slot should be refilled immediately');
  assert.equal(world.lobby.get(waiting).status, 'live');
});

test('a normal death costs the standard cooldown', () => {
  const world = makeWorld();
  const victim = addAgent(world, 'V');
  addAgent(world, 'K');
  world.killAgent(victim.agent, null);
  assert.equal(victim.status, 'cooldown');
  assert.equal(Math.round(victim.readyAt - world.time), LOBBY.respawnCooldown);
});

test('dying while the arena is full and the queue is deep costs the long cooldown', () => {
  const world = makeWorld();
  // Ten in the arena, plus enough waiting to exceed the congestion threshold.
  for (let i = 0; i < WORLD.maxAgents + LOBBY.congestedQueueLength + 1; i++) addAgent(world, `A${i}`);
  assert.equal(world.agents.length, WORLD.maxAgents);
  assert.ok(world.lobby.queue.length > LOBBY.congestedQueueLength, `queue is ${world.lobby.queue.length}`);

  const victim = world.agents[0].participant;
  world.killAgent(world.agents[0], null);
  assert.equal(Math.round(victim.readyAt - world.time), LOBBY.congestedCooldown);
});

test('a cooldown that expires puts the agent back in the queue, not straight in', () => {
  const world = makeWorld();
  for (let i = 0; i < 12; i++) addAgent(world, `A${i}`);
  const victim = world.agents[0].participant;
  world.killAgent(world.agents[0], null);

  world.time += LOBBY.respawnCooldown + 1;
  world.lobby.update();
  assert.notEqual(victim.status, 'cooldown');
});

test('a kill is credited to the shooter', () => {
  const world = makeWorld();
  const killer = addAgent(world, 'K');
  const victim = addAgent(world, 'V');
  world.killAgent(victim.agent, killer.agent);
  assert.equal(killer.kills, 1);
  assert.equal(victim.deaths, 1);
});

console.log('\n-- loot ----------------------------------------------------------');

test('a health pack heals a wounded agent and is consumed', () => {
  const world = makeWorld();
  const p = addAgent(world, 'A');
  p.agent.hp = 40;
  world.pickups.push({ id: 'k1', kind: 'health', heal: 25, radius: 10, color: '#fff', label: 'Medkit +25', x: p.agent.x, y: p.agent.y, expiresAt: 999 });

  world.stepLoot(1 / 60);
  assert.equal(p.agent.hp, 65);
  assert.equal(world.pickups.length, 0);
});

test('healing never overshoots the cap, and a full agent leaves the pack', () => {
  const world = makeWorld();
  const p = addAgent(world, 'A');
  p.agent.hp = 90;
  world.pickups.push({ id: 'k1', kind: 'health', heal: 50, radius: 14, color: '#fff', label: 'Medkit +50', x: p.agent.x, y: p.agent.y, expiresAt: 999 });
  world.stepLoot(1 / 60);
  assert.equal(p.agent.hp, AGENT.maxHp);

  world.pickups.push({ id: 'k2', kind: 'health', heal: 10, radius: 7, color: '#fff', label: 'Medkit +10', x: p.agent.x, y: p.agent.y, expiresAt: 999 });
  world.stepLoot(1 / 60);
  assert.equal(world.pickups.length, 1, 'a full-health agent should leave the pack for someone else');
});

test('a weapon pickup swaps the weapon and fills the magazine', () => {
  const world = makeWorld();
  const p = addAgent(world, 'A');
  p.agent.ammo = 0;
  world.pickups.push({ id: 'k1', kind: 'weapon', weaponId: 'shotgun', radius: 13, color: '#fff', label: 'Shotgun', x: p.agent.x, y: p.agent.y, expiresAt: 999 });

  world.stepLoot(1 / 60);
  assert.equal(p.agent.weapon, 'shotgun');
  assert.equal(p.agent.ammo, WEAPONS.shotgun.magazine);
});

test('loot spawns on a random cooldown and respects the floor cap', () => {
  const world = makeWorld();
  for (let i = 0; i < 60 * 400; i++) world.update(1 / 60);   // ~400 seconds of world time
  assert.ok(world.pickups.length > 0, 'loot should appear');
  assert.ok(world.pickups.length <= 10, `floor cap exceeded: ${world.pickups.length}`);
});

console.log('\n-- the action surface --------------------------------------------');

test('out-of-range tool arguments are clamped, not rejected', () => {
  const agent = { weapon: 'pistol' };
  assert.equal(normalizeAction({ name: 'turn', input: { direction: 'left', degrees: 9999 } }, agent).total, 180);
  assert.equal(normalizeAction({ name: 'move', input: { direction: 'forward', steps: -5 } }, agent).steps, 1);
  assert.equal(normalizeAction({ name: 'fire', input: { shots: 100 } }, agent).total, WEAPONS.pistol.magazine);
  assert.equal(normalizeAction({ name: 'aim', input: { direction: 'left', degrees: 999 } }, agent).target, -35);
});

test('malformed or unknown tool calls are dropped without throwing', () => {
  const agent = { weapon: 'pistol' };
  assert.equal(normalizeAction(null, agent), null);
  assert.equal(normalizeAction({ name: 'teleport' }, agent), null);
  assert.equal(normalizeAction({ name: 'fire' }, agent).total, 1, 'missing input falls back to a default');
});

test('every tool has a summary for the panel a prompt writer reads', () => {
  assert.deepEqual(Object.keys(TOOL_SUMMARIES).sort(), [...TOOL_NAMES].sort(),
    'adding a tool means documenting it in TOOL_SUMMARIES too');
  for (const [name, text] of Object.entries(TOOL_SUMMARIES)) {
    assert.ok(text.length > 20, `${name} needs a real summary`);
  }
  assert.match(TOOL_SUMMARIES.move, /sidestep/, 'the move summary must mention sidestepping');
});

test('a plan is capped at four actions', () => {
  const calls = Array.from({ length: 9 }, () => ({ name: 'hold', input: { seconds: 1 } }));
  assert.equal(buildQueue(calls, { weapon: 'pistol' }).length, 4);
});

console.log('\n-- sidestepping --------------------------------------------------');

/** Run a movement action to completion on a free-floating body. */
function runMove(direction, steps, facing = 0) {
  const agent = { x: 0, y: 0, facing, aimOffset: 0, weapon: 'pistol' };
  const action = normalizeAction({ name: 'move', input: { direction, steps } }, agent);
  const ctx = {
    now: 0,
    tryMove: (a, dx, dy) => { a.x += dx; a.y += dy; return true; },
    fireWeapon: () => {},
  };
  let elapsed = 0;
  for (let i = 0; i < 6000 && !stepAction(agent, action, 1 / 60, ctx); i++) elapsed += 1 / 60;
  return { agent, elapsed };
}

test('sidestepping moves sideways without rotating the body or the aim', () => {
  const right = runMove('right', 4).agent;
  assert.equal(right.facing, 0, 'the body must not turn');
  assert.equal(right.aimOffset, 0, 'the aim must not move');
  assert.ok(Math.abs(right.x) < 1e-6, `expected no forward travel, got ${right.x}`);
  assert.ok(Math.abs(right.y - 4 * MOVE.stepDistance) < 1, `expected ${4 * MOVE.stepDistance} sideways, got ${right.y}`);

  const left = runMove('left', 4).agent;
  assert.ok(Math.abs(left.y + 4 * MOVE.stepDistance) < 1, 'left should mirror right');
});

test('sidestep direction matches the frame bearings are reported in', () => {
  // An agent told "enemy on your right" must be able to sidestep `right`
  // toward it, so positive bearings and `right` have to agree.
  const world = makeWorld();
  const a = addAgent(world, 'A');
  const b = addAgent(world, 'B');
  Object.assign(a.agent, { x: 200, y: 700, facing: 0 });

  const radians = (15 * Math.PI) / 180;
  Object.assign(b.agent, { x: 200 + Math.cos(radians) * 300, y: 700 + Math.sin(radians) * 300 });
  const enemy = buildSnapshot(a.agent, world).enemies[0];
  assert.ok(enemy.bearing > 0 && enemy.right > 0, 'target placed toward +y must read as right');

  const stepped = runMove('right', 3).agent;
  assert.ok(stepped.y > 0, 'sidestep right must travel toward the same side');
});

test('sidesteps rotate with the body', () => {
  const facingSouth = runMove('right', 4, 90).agent;   // facing +y, right is -x
  assert.ok(Math.abs(facingSouth.x + 4 * MOVE.stepDistance) < 1, `expected -x travel, got ${facingSouth.x}`);
  assert.ok(Math.abs(facingSouth.y) < 1e-6);
});

test('sidestepping is slower than walking forward and faster than backing up', () => {
  assert.ok(MOVE.sidestepSpeed < MOVE.forwardSpeed, 'keeping your aim should cost ground speed');
  assert.ok(MOVE.sidestepSpeed > MOVE.backwardSpeed);

  const forward = runMove('forward', 6).elapsed;
  const side = runMove('right', 6).elapsed;
  const back = runMove('backward', 6).elapsed;
  assert.ok(forward < side && side < back, `timings out of order: ${forward}/${side}/${back}`);
});

test('every movement direction is covered and unknown ones fall back safely', () => {
  assert.deepEqual(Object.keys(MOVE_DIRECTIONS).sort(), ['backward', 'forward', 'left', 'right']);
  const schema = TOOL_SCHEMAS.find((t) => t.name === 'move');
  assert.deepEqual(schema.input_schema.properties.direction.enum.sort(), ['backward', 'forward', 'left', 'right']);
  assert.equal(normalizeAction({ name: 'move', input: { direction: 'sideways', steps: 2 } }, { weapon: 'pistol' }).direction, 'forward');
});

test('sidesteps read as sidesteps in the action feed', () => {
  const agent = { weapon: 'pistol' };
  assert.equal(describeAction(normalizeAction({ name: 'move', input: { direction: 'left', steps: 3 } }, agent)), 'sidestep left 3');
  assert.equal(describeAction(normalizeAction({ name: 'move', input: { direction: 'forward', steps: 3 } }, agent)), 'move forward 3');
});

test('a wall stops a sidestep the same way it stops a walk', () => {
  const world = makeWorld();
  const p = addAgent(world, 'A');
  // Shoulder against the centre bar, facing east, so sidestepping right hits it.
  Object.assign(p.agent, { x: 700, y: 740 + WORLD.agentRadius + 2, facing: 180 });
  const action = normalizeAction({ name: 'move', input: { direction: 'right', steps: 8 } }, p.agent);
  const ctx = { now: 0, tryMove: (a, dx, dy) => world.tryMove(a, dx, dy), fireWeapon: () => {} };

  let finished = false;
  for (let i = 0; i < 600 && !finished; i++) finished = stepAction(p.agent, action, 1 / 60, ctx);
  assert.ok(finished, 'the action must end rather than grind into the wall');
  assert.ok(clearance(p.agent.x, p.agent.y) > -1, 'the body must not end up inside the wall');
});

console.log('\n-- prompts drive behaviour ---------------------------------------');

test('different prompts produce meaningfully different traits', () => {
  const rusher = parsePrompt('Be aggressive, hunt and charge at point blank range. Never retreat.');
  const camper = parsePrompt('Camp and ambush. Conserve ammo. Retreat below 40 hp and grab health packs.');

  assert.ok(rusher.aggression > camper.aggression);
  assert.ok(rusher.preferredDistance < camper.preferredDistance);
  assert.equal(rusher.retreatAt, 0, 'never retreat should disable the threshold');
  assert.equal(camper.retreatAt, 40, 'an explicit hp threshold should be read out of the prompt');
  assert.ok(camper.camp > rusher.camp);
  assert.ok(camper.loot > rusher.loot);
  assert.ok(camper.trigger < 0, 'conserve ammo should tighten trigger discipline');
});

test('sidestepping is off by default and prompts turn it on', () => {
  assert.ok(parsePrompt('attack the nearest enemy and shoot it').strafe <= 0.3,
    'a prompt that never mentions movement should not strafe');
  assert.ok(parsePrompt('circle your target while firing, never stop moving').strafe > 0.3);
  assert.ok(parsePrompt('dodge incoming fire by sidestepping').strafe > 0.3);
  assert.ok(parsePrompt('camp in a corner and hold your ground, do not move').strafe < 0);
});

test('a weapon preference is picked up from the prompt', () => {
  assert.equal(parsePrompt('grab the shotgun and brawl').wantWeapon, 'shotgun');
  assert.equal(parsePrompt('find an assault rifle').wantWeapon, 'assault');
  assert.equal(parsePrompt('just walk around').wantWeapon, null);
});

console.log('\n-- speech bubbles ------------------------------------------------');

test('a new line replaces the current one and restarts the clock', () => {
  const world = makeWorld();
  const p = addAgent(world, 'A');

  world.say(p.agent, 'Contact!');
  const first = p.agent.chat.until;
  assert.equal(p.agent.chat.text, 'Contact!');

  // Half a second later, saying something else must reset the full duration -
  // this is what lets a talkative agent hold one continuous bubble.
  world.time += 0.5;
  world.say(p.agent, 'Reloading!');
  assert.equal(p.agent.chat.text, 'Reloading!');
  assert.ok(p.agent.chat.until > first, 'the clock must restart, not carry over');
  assert.equal(Math.round(p.agent.chat.until - world.time), CHAT.duration);
});

test('a bubble expires once nothing new is said', () => {
  const world = makeWorld();
  const p = addAgent(world, 'A');
  world.say(p.agent, 'Anyone there?');

  world.time += CHAT.duration - 0.1;
  assert.ok(p.agent.chat.until > world.time, 'still alive just before the deadline');
  world.time += 0.2;
  assert.ok(p.agent.chat.until <= world.time, 'expired just after');
});

test('empty lines are ignored and long ones are cut', () => {
  const world = makeWorld();
  const p = addAgent(world, 'A');

  world.say(p.agent, '   ');
  assert.equal(p.agent.chat, null, 'whitespace should not open a bubble');

  world.say(p.agent, 'x'.repeat(400));
  assert.ok(p.agent.chat.text.length <= CHAT.maxLength, `got ${p.agent.chat.text.length} chars`);
  assert.ok(p.agent.chat.text.endsWith('…'));
});

test('a {"chat"} object is lifted out of a model reply and off the note', () => {
  const plain = extractChat('Closing in. {"chat": "im attacking!"}');
  assert.equal(plain.chat, 'im attacking!');
  assert.equal(plain.rest, 'Closing in.', 'the bubble must not also appear in the note');

  assert.equal(extractChat('nothing here').chat, null);
  assert.equal(extractChat('{"chat": "first"} {"chat": "second"}').chat, 'first', 'first line wins');
  assert.equal(extractChat('{"chat": "he said \\"hi\\""}').chat, 'he said "hi"', 'escapes survive');
  assert.equal(extractChat('').chat, null);
});

test('a malformed chat object is dropped rather than rendered', () => {
  const broken = extractChat('{"chat": } oops');
  assert.equal(broken.chat, null, 'no bubble');
  assert.match(broken.rest, /oops/, 'the text is left alone');
  assert.equal(extractChat('{"chat": 42}').chat, null, 'a non-string is not a line');
});

test('bubble text wraps to at most two lines', () => {
  const lines = wrapChat('Contact on the left, moving to flank him right now before he turns');
  assert.ok(lines.length <= CHAT.maxLines, `got ${lines.length} lines`);
  assert.ok(lines.every((l) => l.length <= CHAT.lineWidth + 2), JSON.stringify(lines));
  assert.deepEqual(wrapChat('Down!'), ['Down!'], 'a short line stays on one');
  assert.equal(tidy('  lots   of\n  space '), 'lots of space');
});

test('the offline brain speaks when something happens, not every tick', async () => {
  const brain = createLocalBrain({ thinkTime: [0, 0] });
  const participant = createParticipant({ name: 'Talker', prompt: 'Be aggressive and hunt enemies.', brainKind: 'local', colorIndex: 0 });

  const snapshot = (time, events = []) => ({
    tick: 1, time,
    self: { name: 'Talker', hp: 100, maxHp: 100, weapon: 'Pistol', weaponId: 'pistol', ammo: 3, magazine: 3,
      reloading: false, canFireNow: true, heading: 90, headingLabel: 'E', aimOffset: 0 },
    vision: { fovDegrees: 45, range: 620 },
    enemies: [], loot: [],
    walls: { cone: Array.from({ length: 9 }, (_, i) => ({ bearing: -22.5 + i * 5.625, distance: 500 })),
      proximity: { front: 400, right: 400, back: 400, left: 400 } },
    events, arena: { agentsAlive: 2, queueLength: 0 },
  });

  const kill = await brain.decide(snapshot(10, ['You killed Vex.']), participant);
  assert.ok(kill.chat, 'a kill is worth saying something about');
  assert.match(kill.chat, /Vex|Down|Next|easy|Clear/);

  // Two gates keep ten agents readable. First: nothing at all within the
  // minimum interval, whatever happened.
  const tooSoon = await brain.decide(snapshot(10.5, ['Took 20 damage from ahead. HP now 80.']), participant);
  assert.equal(tooSoon.chat, null, `spoke again after 0.5s: ${tooSoon.chat}`);

  // Second: a *different* situation may speak once the interval has passed.
  const different = await brain.decide(
    snapshot(10 + CHAT.minInterval + 0.5, ['Took 20 damage from ahead. HP now 80.']), participant);
  assert.ok(different.chat, 'a new kind of event should get a line');

  // But repeating the same situation needs a longer gap, so an agent on a
  // killing spree does not shout the same thing over and over.
  const fresh = createParticipant({ name: 'Spree', prompt: 'Be aggressive and hunt enemies.', brainKind: 'local', colorIndex: 1 });
  assert.ok((await brain.decide(snapshot(50, ['You killed A.']), fresh)).chat);
  assert.equal((await brain.decide(snapshot(50 + CHAT.minInterval + 0.5, ['You killed B.']), fresh)).chat, null,
    'the same bark must not repeat just because the interval elapsed');
  assert.ok((await brain.decide(snapshot(50 + CHAT.duration * 3 + 0.5, ['You killed C.']), fresh)).chat,
    'after the longer repeat window it may say it again');
});

console.log('\n-- hard rules from the prompt ------------------------------------');

test('an absolute prompt is parsed into rules the arena can enforce', () => {
  const c = parseConstraints(
    'follow these rules exactly: never move, only turn right, never fire, never aim, never reload and never hold');
  assert.ok(hasConstraints(c));
  for (const tool of ['move', 'fire', 'aim', 'reload', 'hold']) {
    assert.ok(c.banned.has(tool), `${tool} should be banned`);
  }
  assert.deepEqual([...c.directions.turn.allow], ['right']);
});

test('obedience is left to the model by default', () => {
  assert.equal(HARD_RULES.enforce, false,
    'an agent with memory and its orders in a cached system prompt owns its own obedience');
});

test('the mechanical backstop, when switched on, binds a prompt-blind brain', async () => {
  // Exactly the stub model's behaviour: sensible tactics, prompt ignored.
  HARD_RULES.enforce = true;
  const ignorant = {
    decide: async () => ({
      actions: [
        { name: 'move', input: { direction: 'forward', steps: 3 } },
        { name: 'turn', input: { direction: 'left', degrees: 40 } },
        { name: 'fire', input: { shots: 2 } },
        { name: 'turn', input: { direction: 'right', degrees: 30 } },
      ],
    }),
  };
  const world = new World({ seed: 4, brains: { local: ignorant, claude: ignorant } });
  const participant = createParticipant({
    name: 'Rules', prompt: 'never move, only turn right, never fire, never aim, never reload and never hold',
    brainKind: 'local', colorIndex: 0,
  });
  world.lobby.add(participant);

  const startX = participant.agent.x;
  const startY = participant.agent.y;
  for (let i = 0; i < 60 * 6; i++) {
    world.update(1 / 60);
    if (i % 30 === 0) await new Promise((r) => setImmediate(r));
  }

  assert.deepEqual(participant.agent.lastActions, ['turn right 30°'], 'only the legal call survives');
  assert.equal(participant.shotsFired, 0, 'never fire must mean no shots');
  assert.ok(Math.hypot(participant.agent.x - startX, participant.agent.y - startY) < 1,
    'never move must mean it has not moved');
  assert.ok(participant.agent.lastRefused.length > 0, 'and it is told what was refused');
  HARD_RULES.enforce = false;
});

test('a refusal names the rule so a model can adapt', () => {
  const c = parseConstraints('never fire, only turn right');
  assert.match(violation({ type: 'fire' }, c), /forbid fire/);
  assert.match(violation({ type: 'turn', direction: 'left' }, c), /only right/);
  assert.equal(violation({ type: 'turn', direction: 'right' }, c), null);
  assert.equal(violation({ type: 'move', direction: 'forward' }, c), null, 'unmentioned tools stay free');
});

test('the idle beat is exempt, so a fully bound agent does not deadlock', () => {
  const c = parseConstraints('never move, never turn, never fire, never aim, never reload, never hold');
  assert.equal(violation({ type: 'hold', forced: true }, c), null, 'the forced idle must survive');
  assert.match(violation({ type: 'hold' }, c), /forbid hold/, 'but a hold the brain chose does not');
});

test('direction-specific rules restrict without banning the whole tool', () => {
  const c = parseConstraints('do not move backward. never turn left.');
  assert.equal(c.banned.has('move'), false, 'moving is still allowed');
  assert.match(violation({ type: 'move', direction: 'backward' }, c), /forbid move backward/);
  assert.equal(violation({ type: 'move', direction: 'forward' }, c), null);
  assert.match(violation({ type: 'turn', direction: 'left' }, c), /forbid turn left/);
});

test('phrases that only look like prohibitions are left alone', () => {
  // "never stop moving" is the opposite of a ban on moving.
  assert.equal(hasConstraints(parseConstraints('Be aggressive. Never stop moving.')), false);
  assert.equal(hasConstraints(parseConstraints('Never retreat. Hunt them down and shoot.')), false);
  assert.equal(hasConstraints(parseConstraints('Camp in a corner and hold your ground.')), false);
  assert.equal(hasConstraints(parseConstraints('Circle your target while firing.')), false);
});

test('enforce keeps legal actions and reports the rest once each', () => {
  const c = parseConstraints('never fire');
  const { actions, refused } = enforce(
    [{ type: 'turn', direction: 'left' }, { type: 'fire' }, { type: 'fire' }], c);
  assert.equal(actions.length, 1);
  assert.deepEqual(refused, ['your orders forbid fire'], 'duplicates collapse');
  assert.match(describeConstraints(c), /never fire/);
});

test('a prompt with no absolutes constrains nothing', () => {
  const { actions, refused } = enforce(
    [{ type: 'fire' }, { type: 'move', direction: 'forward' }],
    parseConstraints('Be aggressive and hunt the nearest enemy.'));
  assert.equal(actions.length, 2);
  assert.equal(refused.length, 0);
});

console.log('\n-- assists, pulses and champions ---------------------------------');

test('damaging a victim someone else finishes earns an assist', () => {
  const world = makeWorld();
  const victim = addAgent(world, 'V');
  const helper = addAgent(world, 'H');
  const killer = addAgent(world, 'K');
  for (const a of [victim.agent, helper.agent, killer.agent]) a.spawnProtectedUntil = 0;

  world.applyDamage(victim.agent, 30, helper.agent, 'Pistol');
  world.applyDamage(victim.agent, 70, killer.agent, 'Pistol');   // this one kills

  assert.equal(killer.kills, 1);
  assert.equal(killer.assists, 0, 'the killer does not assist their own kill');
  assert.equal(helper.assists, 1);
  assert.equal(victim.deaths, 1);
});

test('damage that has gone stale earns no assist', () => {
  const world = makeWorld();
  const victim = addAgent(world, 'V');
  const helper = addAgent(world, 'H');
  const killer = addAgent(world, 'K');
  for (const a of [victim.agent, helper.agent, killer.agent]) a.spawnProtectedUntil = 0;

  world.applyDamage(victim.agent, 30, helper.agent, 'Pistol');
  world.time += PULSE.assistWindow + 1;
  world.applyDamage(victim.agent, 70, killer.agent, 'Pistol');

  assert.equal(helper.assists, 0, `assist window is ${PULSE.assistWindow}s`);
  assert.equal(killer.kills, 1);
});

test('actions stamp a pulse the focus bar can flash on', () => {
  const world = makeWorld();
  const p = addAgent(world, 'A');
  p.agent.spawnProtectedUntil = 0;
  assert.equal(p.agent.pulses.fire, -Infinity);

  world.time = 5;
  world.fireWeapon(p.agent);
  assert.equal(p.agent.pulses.fire, 5, 'firing must stamp the weapon tile');

  world.time = 6;
  world.applyDamage(p.agent, 10, null, 'Pistol');
  assert.equal(p.agent.pulses.hurt, 6);
});

test('each life becomes a champion record scored on that life alone', () => {
  const world = makeWorld();
  const killer = addAgent(world, 'K');
  killer.agent.spawnProtectedUntil = 0;

  for (let i = 0; i < 3; i++) {
    const victim = addAgent(world, `V${i}`);
    victim.agent.spawnProtectedUntil = 0;
    world.time += 1;
    world.killAgent(victim.agent, killer.agent);
  }
  assert.equal(killer.kills, 3);
  assert.equal(killer.agent.lifeKills, 3);

  world.time += 5;
  world.killAgent(killer.agent, null);

  const best = world.champions[0];
  assert.equal(best.name, 'K');
  assert.equal(best.kills, 3, 'the record scores the life, not the career');
  assert.ok(best.survived > 0);
  assert.equal(world.champions.length, 4, 'every ended life is recorded');
});

test('the champions board ranks by kills and never exceeds ten rows', () => {
  const world = makeWorld();
  for (let i = 0; i < 16; i++) {
    const p = addAgent(world, `A${i}`);
    p.agent.lifeKills = i;          // later agents did better
    world.killAgent(p.agent, null);
  }
  assert.equal(world.champions.length, PULSE.championRows);
  assert.equal(world.champions[0].kills, 15, 'best life first');
  const kills = world.champions.map((c) => c.kills);
  assert.deepEqual(kills, [...kills].sort((a, b) => b - a), 'must stay sorted');
  assert.ok(Math.min(...kills) > 5, 'the weakest lives should have been pushed off');
});

test('a respawned agent starts a fresh life score', () => {
  const world = makeWorld();
  const p = addAgent(world, 'A');
  p.agent.lifeKills = 4;
  world.killAgent(p.agent, null);

  world.time += LOBBY.respawnCooldown + 1;
  world.lobby.update();
  assert.equal(p.agent.lifeKills, 0, 'the new life starts at zero');
  assert.equal(p.kills, 0, 'career kills are separate and unchanged here');
});

console.log('\n-- a full match --------------------------------------------------');

await asyncTest('ten prompted agents fight for two minutes without errors', async () => {
  const brain = createLocalBrain({ thinkTime: [0, 0] });
  const world = new World({ seed: 99, brains: { local: brain, claude: brain } });

  const prompts = [
    'Be aggressive. Hunt the nearest enemy and close to under 200 units, then fire bursts. Never retreat.',
    'Camp and ambush. Hold position, conserve ammo, single accurate shots. Retreat below 50 hp.',
    'Grab every health pack and pick up the shotgun. Avoid fights until you have a better weapon.',
    'Spin clockwise to scan. Fire the moment anything enters your cone. Do not chase.',
    'Keep a wall on your left and patrol the perimeter. Shoot anything you see. Retreat below 30 hp.',
    'Fight at long range, keep 450 units of distance, fire single shots, reload whenever clear.',
    'Circle your target by sidestepping while you fire. Never stop moving. Aggressive.',
  ];
  for (let i = 0; i < 12; i++) {
    world.lobby.add(createParticipant({
      name: `Bot${i}`, prompt: prompts[i % prompts.length], brainKind: 'local', colorIndex: i,
    }));
  }

  // 120 seconds of simulation, letting queued brain promises settle as we go.
  for (let i = 0; i < 60 * 120; i++) {
    world.update(1 / 60);
    if (i % 60 === 0) await new Promise((r) => setImmediate(r));
  }

  const participants = world.lobby.list();
  const shots = participants.reduce((s, p) => s + p.shotsFired, 0);
  const damage = participants.reduce((s, p) => s + p.damageDealt, 0);
  const kills = participants.reduce((s, p) => s + p.kills, 0);
  const errors = participants.map((p) => p.lastError).filter(Boolean);

  console.log(`      ${shots} shots, ${Math.round(damage)} damage, ${kills} kills, ${participants.reduce((s, p) => s + p.decisions, 0)} decisions`);
  assert.deepEqual(errors, [], 'no brain should have errored');
  assert.ok(shots > 30, `expected a real firefight, got ${shots} shots`);
  assert.ok(kills > 0, 'expected at least one kill in two minutes');
  assert.ok(world.agents.length <= WORLD.maxAgents);
  assert.ok(world.agents.every((a) => clearance(a.x, a.y) > -1), 'no agent should end up inside a wall');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
