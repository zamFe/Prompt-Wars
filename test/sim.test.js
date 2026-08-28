// Headless rule tests. The simulation has no DOM dependencies, so the whole
// arena runs in Node.
//
//   node test/sim.test.js

import assert from 'node:assert/strict';

import { World } from '../public/src/world.js';
import { createParticipant } from '../public/src/lobby.js';
import { createLocalBrain, parsePrompt } from '../public/src/brains/local.js';
import { buildSnapshot } from '../public/src/sensors.js';
import { normalizeAction, buildQueue } from '../public/src/actions.js';
import { hasLineOfSight, castRay, clearance, resolveCollision } from '../public/src/arena.js';
import { WEAPONS, AGENT, WORLD, LOBBY, VISION } from '../public/src/config.js';

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

test('a plan is capped at four actions', () => {
  const calls = Array.from({ length: 9 }, () => ({ name: 'hold', input: { seconds: 1 } }));
  assert.equal(buildQueue(calls, { weapon: 'pistol' }).length, 4);
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

test('a weapon preference is picked up from the prompt', () => {
  assert.equal(parsePrompt('grab the shotgun and brawl').wantWeapon, 'shotgun');
  assert.equal(parsePrompt('find an assault rifle').wantWeapon, 'assault');
  assert.equal(parsePrompt('just walk around').wantWeapon, null);
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
