// The simulation: bodies, bullets, loot, damage and the decision loop.

import { WORLD, MOVE, WEAPONS, AGENT, HEALTH_PACKS, LOOT, VISION, BRAIN, AGENT_COLORS, CHAT, PULSE, HARD_RULES } from './config.js';
import { makeRng, clamp, dist, toRad, normalizeDeg, randRange, weightedPick, pointSegmentDistance, round0 } from './util.js';
import { findOpenPosition, resolveCollision, hasLineOfSight, castRay } from './arena.js';
import { buildSnapshot, bearingTo } from './sensors.js';
import { buildQueue, stepAction, describeAction, describeOutcome } from './actions.js';
import { enforce, hasConstraints, describeConstraints } from './constraints.js';
import { Lobby } from './lobby.js';

const SPAWN_PROTECTION = 1.5;
let nextAgentId = 1;
let nextPickupId = 1;
let nextProjectileId = 1;

export class World {
  constructor({ seed = Date.now(), brains } = {}) {
    this.rng = makeRng(seed);
    this.brains = brains;              // { local, claude } - each has decide()
    this.time = 0;
    this.tickCount = 0;
    this.agents = [];
    this.projectiles = [];
    this.pickups = [];
    this.effects = [];                 // short-lived visuals (hits, deaths)
    this.log = [];
    this.lobby = new Lobby(this);
    this.champions = [];               // best single lives, highest kills first
    this.onSay = null;                 // set by the client to mirror bubbles into the comms log
    this.nextLootAt = randRange(this.rng, ...LOOT.spawnCooldown);
    this.paused = false;
  }

  get queue() {
    return this.lobby.queue;
  }

  /**
   * Put a line in an agent's bubble. Saying something new replaces whatever is
   * there and restarts the clock, so continuous chatter reads as one bubble
   * that never drops rather than a flicker of separate ones.
   */
  say(agent, text) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!line) return;
    agent.chat = {
      text: line.length > CHAT.maxLength ? `${line.slice(0, CHAT.maxLength - 1)}…` : line,
      until: this.time + CHAT.duration,
      saidAt: this.time,
    };
    this.onSay?.(agent, agent.chat.text);
  }

  pulse(agent, kind) {
    agent.pulses[kind] = this.time;
  }

  addLog(text, kind = 'info') {
    this.log.push({ time: this.time, text, kind });
    if (this.log.length > 200) this.log.shift();
  }

  // ---------------------------------------------------------------- lifecycle

  spawnAgent(participant) {
    const weapon = WEAPONS[AGENT.startWeapon];
    const spot = findOpenPosition(this.rng, {
      avoid: this.agents.filter((a) => a.alive),
      minAvoidDistance: 300,
    });

    const agent = {
      id: `a${nextAgentId++}`,
      participant,
      name: participant.name,
      color: AGENT_COLORS[participant.colorIndex % AGENT_COLORS.length],
      x: spot.x,
      y: spot.y,
      facing: randRange(this.rng, -180, 180),
      aimOffset: 0,
      hp: AGENT.maxHp,
      alive: true,
      weapon: weapon.id,
      ammo: weapon.magazine,
      nextShotAt: 0,
      reloadUntil: 0,
      spawnProtectedUntil: this.time + SPAWN_PROTECTION,

      queue: [],
      current: null,
      thinking: false,
      thinkToken: 0,
      nextDecisionAt: 0,
      lastActions: [],
      lastRefused: [],
      // What became of the last plan, reported back on the next decision.
      planResults: [],
      turn: 0,
      memoryDepth: 0,
      lastSnapshot: null,
      lastNote: null,
      lastError: null,
      pendingEvents: hasConstraints(participant.constraints)
        ? [`You have entered the arena. Your orders bind you: ${describeConstraints(participant.constraints)}.`]
        : ['You have entered the arena.'],
      blocked: false,
      lastInterruptAt: -Infinity,
      spawnedAt: this.time,

      chat: null,                 // { text, until, saidAt }
      // Timestamps of the last time each action fired, for the focus bar.
      pulses: { fire: -Infinity, reload: -Infinity, hurt: -Infinity, heal: -Infinity, kill: -Infinity, pickup: -Infinity },
      // Who has hurt this agent lately, for assist credit: id -> { damage, at }.
      recentDamage: new Map(),
      lifeKills: 0,
      lifeAssists: 0,
    };

    this.agents.push(agent);
    participant.agent = agent;
    this.addLog(`${participant.name} entered the arena.`, 'join');
    return agent;
  }

  removeAgentFor(participantId) {
    this.agents = this.agents.filter((a) => a.participant.id !== participantId);
  }

  killAgent(agent, killer) {
    if (!agent.alive) return;

    // Read the congestion state *before* this agent stops counting as alive -
    // the long cooldown is about the arena you died in, not the one you left.
    const congested = this.lobby.isCongested();

    agent.alive = false;
    agent.hp = 0;
    this.effects.push({ kind: 'death', x: agent.x, y: agent.y, color: agent.color, until: this.time + 0.8 });

    if (killer && killer !== agent) {
      killer.participant.kills += 1;
      killer.lifeKills += 1;
      killer.pendingEvents.push(`You killed ${agent.name}.`);
      this.pulse(killer, 'kill');
      this.addLog(`${killer.name} killed ${agent.name}.`, 'kill');
    } else {
      this.addLog(`${agent.name} died.`, 'kill');
    }

    // Anyone else who hurt the victim recently gets an assist.
    for (const [participantId, record] of agent.recentDamage) {
      if (killer && participantId === killer.participant.id) continue;
      if (this.time - record.at > PULSE.assistWindow) continue;
      const helper = this.lobby.get(participantId);
      if (!helper) continue;
      helper.assists = (helper.assists ?? 0) + 1;
      if (helper.agent) {
        helper.agent.lifeAssists += 1;
        helper.agent.pendingEvents.push(`You assisted in killing ${agent.name}.`);
      }
    }

    this.recordChampion(agent);

    // A life's conversation dies with it: the next life starts with no memory.
    for (const brain of Object.values(this.brains ?? {})) brain.endSession?.(agent.id);

    const wait = this.lobby.onDeath(agent.participant, congested);
    agent.participant.agent = null;
    this.agents = this.agents.filter((a) => a !== agent);
    this.addLog(`${agent.name} may rejoin in ${Math.round(wait)}s.`, 'info');
    this.lobby.pump();
  }

  /** Every life ends with a score; the board keeps the ten best. */
  recordChampion(agent) {
    this.champions.push({
      name: agent.name,
      color: agent.color,
      participantId: agent.participant.id,
      brainKind: agent.participant.brainKind,
      kills: agent.lifeKills,
      assists: agent.lifeAssists,
      survived: this.time - agent.spawnedAt,
      diedAt: this.time,
    });
    // Highest kills first; a tie goes to the life that lasted longer.
    this.champions.sort((a, b) => b.kills - a.kills || b.assists - a.assists || b.survived - a.survived);
    this.champions.length = Math.min(this.champions.length, PULSE.championRows);
  }

  // ---------------------------------------------------------------- combat

  applyDamage(target, amount, attacker, weaponName) {
    if (!target.alive) return;
    if (this.time < target.spawnProtectedUntil) return;

    const dealt = Math.min(amount, target.hp);
    target.hp -= amount;
    target.participant.damageTaken += dealt;
    this.pulse(target, 'hurt');

    if (attacker) {
      attacker.participant.damageDealt += dealt;
      const record = target.recentDamage.get(attacker.participant.id) ?? { damage: 0, at: 0 };
      record.damage += dealt;
      record.at = this.time;
      target.recentDamage.set(attacker.participant.id, record);
    }

    const from = attacker ? bearingTo(target, attacker.x, attacker.y) : 0;
    const side =
      Math.abs(from) < 45 ? 'ahead' : Math.abs(from) > 135 ? 'behind you' : from > 0 ? 'your right' : 'your left';
    target.pendingEvents.push(
      `Took ${Math.round(dealt)} damage from ${side}${weaponName ? ` (${weaponName})` : ''}. HP now ${Math.max(0, Math.round(target.hp))}.`,
    );

    // Being shot cancels the rest of the current plan so the agent can react,
    // but not more often than damageInterruptCooldown or it would never act.
    if (this.time - target.lastInterruptAt > BRAIN.damageInterruptCooldown) {
      target.lastInterruptAt = this.time;
      if (target.current?.type !== 'reload') {
        this.recordOutcome(target, target.current, { interrupted: true });
        for (const pending of target.queue) {
          target.planResults.push({
            id: pending.id ?? null,
            action: describeAction(pending),
            outcome: 'never ran - you broke off the plan when you were hit',
          });
        }
        target.queue = [];
        target.current = null;
      }
    }

    if (target.hp <= 0) this.killAgent(target, attacker);
  }

  fireWeapon(agent) {
    const weapon = WEAPONS[agent.weapon] ?? WEAPONS.pistol;
    if (agent.ammo <= 0) return;

    agent.ammo -= 1;
    agent.nextShotAt = this.time + weapon.timeBetweenShots;
    agent.participant.shotsFired += 1;
    this.pulse(agent, 'fire');

    const baseAngle = agent.facing + agent.aimOffset;
    for (let i = 0; i < weapon.pellets; i++) {
      const jitter = randRange(this.rng, -weapon.spread, weapon.spread);
      const rad = toRad(baseAngle + jitter);
      this.projectiles.push({
        id: `b${nextProjectileId++}`,
        x: agent.x + Math.cos(rad) * (WORLD.agentRadius + 2),
        y: agent.y + Math.sin(rad) * (WORLD.agentRadius + 2),
        dx: Math.cos(rad),
        dy: Math.sin(rad),
        speed: weapon.bulletSpeed,
        damage: weapon.damage,
        range: weapon.range,
        falloffStart: weapon.falloffStart,
        falloffFloor: weapon.falloffFloor,
        travelled: 0,
        owner: agent,
        color: weapon.color,
        weaponName: weapon.name,
      });
    }
    this.effects.push({
      kind: 'muzzle',
      x: agent.x,
      y: agent.y,
      angle: baseAngle,
      color: weapon.color,
      until: this.time + 0.06,
    });
  }

  stepProjectiles(dt) {
    const survivors = [];

    for (const p of this.projectiles) {
      const travel = Math.min(p.speed * dt, p.range - p.travelled);
      const x2 = p.x + p.dx * travel;
      const y2 = p.y + p.dy * travel;

      // Wall first - a bullet cannot pass through cover to reach a body behind it.
      const wallHit = castRay(p.x, p.y, p.dx, p.dy, travel);
      const limit = Math.min(travel, wallHit);

      let closest = null;
      let closestDistance = Infinity;
      for (const agent of this.agents) {
        if (!agent.alive || agent === p.owner) continue;
        if (this.time < agent.spawnProtectedUntil) continue;
        const d = pointSegmentDistance(agent.x, agent.y, p.x, p.y, p.x + p.dx * limit, p.y + p.dy * limit);
        if (d > WORLD.agentRadius) continue;
        const along = dist(p.x, p.y, agent.x, agent.y);
        if (along < closestDistance) {
          closestDistance = along;
          closest = agent;
        }
      }

      if (closest) {
        const total = p.travelled + closestDistance;
        const scale =
          total <= p.falloffStart
            ? 1
            : clamp(
                1 - ((total - p.falloffStart) / Math.max(1, p.range - p.falloffStart)) * (1 - p.falloffFloor),
                p.falloffFloor,
                1,
              );
        this.applyDamage(closest, p.damage * scale, p.owner, p.weaponName);
        this.effects.push({ kind: 'hit', x: closest.x, y: closest.y, color: p.color, until: this.time + 0.18 });
        continue;
      }

      if (wallHit < travel) {
        this.effects.push({
          kind: 'spark',
          x: p.x + p.dx * wallHit,
          y: p.y + p.dy * wallHit,
          color: p.color,
          until: this.time + 0.12,
        });
        continue;
      }

      p.x = x2;
      p.y = y2;
      p.travelled += travel;
      if (p.travelled < p.range) survivors.push(p);
    }

    this.projectiles = survivors;
  }

  // ---------------------------------------------------------------- loot

  spawnPickup() {
    const kind = weightedPick(this.rng, LOOT.weights);
    if (!kind) return;

    const spot = findOpenPosition(this.rng, {
      radius: 16,
      avoid: [...this.agents.filter((a) => a.alive), ...this.pickups],
      minAvoidDistance: 160,
    });

    let item;
    if (kind.startsWith('health')) {
      const heal = Number(kind.replace('health', ''));
      const spec = HEALTH_PACKS[heal];
      item = {
        kind: 'health',
        heal,
        radius: spec.radius,
        color: spec.color,
        label: `Medkit +${heal}`,
        sizeLabel: spec.label,
      };
    } else {
      const weapon = WEAPONS[kind];
      item = {
        kind: 'weapon',
        weaponId: weapon.id,
        radius: 13,
        color: weapon.color,
        label: weapon.name,
      };
    }

    this.pickups.push({
      id: `k${nextPickupId++}`,
      x: spot.x,
      y: spot.y,
      expiresAt: this.time + LOOT.lifetime,
      spawnedAt: this.time,
      ...item,
    });
  }

  stepLoot(dt) {
    if (this.time >= this.nextLootAt) {
      if (this.pickups.length < LOOT.maxOnGround) this.spawnPickup();
      this.nextLootAt = this.time + randRange(this.rng, ...LOOT.spawnCooldown);
    }

    const remaining = [];
    for (const item of this.pickups) {
      if (this.time >= item.expiresAt) continue;

      let taken = false;
      for (const agent of this.agents) {
        if (!agent.alive) continue;
        if (dist(agent.x, agent.y, item.x, item.y) > WORLD.agentRadius + item.radius) continue;

        if (item.kind === 'health') {
          if (agent.hp >= AGENT.maxHp) continue;    // full health leaves it for someone else
          const healed = Math.min(item.heal, AGENT.maxHp - agent.hp);
          agent.hp += healed;
          agent.pendingEvents.push(`Picked up a medkit, healed ${Math.round(healed)}. HP now ${Math.round(agent.hp)}.`);
          this.pulse(agent, 'heal');
          this.addLog(`${agent.name} picked up ${item.label}.`, 'loot');
        } else {
          const weapon = WEAPONS[item.weaponId];
          const sameWeapon = agent.weapon === weapon.id;
          agent.weapon = weapon.id;
          agent.ammo = weapon.magazine;
          agent.reloadUntil = 0;
          agent.pendingEvents.push(
            sameWeapon ? `Restocked ${weapon.name} ammo.` : `Picked up a ${weapon.name}. Magazine ${weapon.magazine}.`,
          );
          this.pulse(agent, 'pickup');
          this.addLog(`${agent.name} picked up ${weapon.name}.`, 'loot');
        }
        this.effects.push({ kind: 'pickup', x: item.x, y: item.y, color: item.color, until: this.time + 0.3 });
        taken = true;
        break;
      }
      if (!taken) remaining.push(item);
    }
    this.pickups = remaining;
  }

  // ---------------------------------------------------------------- movement

  tryMove(agent, dx, dy) {
    const targetX = agent.x + dx;
    const targetY = agent.y + dy;
    const resolved = resolveCollision(targetX, targetY, WORLD.agentRadius);

    // Push apart from other bodies so agents do not stack on one square.
    let px = resolved.x;
    let py = resolved.y;
    for (const other of this.agents) {
      if (other === agent || !other.alive) continue;
      const d = dist(px, py, other.x, other.y);
      const minimum = WORLD.agentRadius * 2;
      if (d < minimum && d > 1e-6) {
        px += ((px - other.x) / d) * (minimum - d) * 0.5;
        py += ((py - other.y) / d) * (minimum - d) * 0.5;
      }
    }
    const settled = resolveCollision(px, py, WORLD.agentRadius);
    agent.x = settled.x;
    agent.y = settled.y;

    // Report "blocked" only when the wall actually ate most of the step.
    const wanted = Math.hypot(dx, dy);
    const achieved = dist(targetX - dx, targetY - dy, agent.x, agent.y);
    return achieved > wanted * 0.35;
  }

  // ---------------------------------------------------------------- decisions

  requestDecision(agent) {
    const snapshot = buildSnapshot(agent, this);
    agent.lastSnapshot = snapshot;
    const consumedEvents = agent.pendingEvents.length;

    const brain = this.brains[agent.participant.brainKind] ?? this.brains.local;
    const token = ++agent.thinkToken;
    agent.thinking = true;

    // The agent's own history of the last plan, handed back so it can see what
    // its previous moves actually achieved.
    const memory = { agentId: agent.id, results: agent.planResults.slice() };
    agent.planResults = [];

    Promise.resolve(brain.decide(snapshot, agent.participant, memory))
      .then((decision) => {
        if (token !== agent.thinkToken || !agent.alive) return;
        agent.thinking = false;
        agent.participant.decisions += 1;
        agent.participant.lastError = null;
        agent.lastError = null;
        agent.lastNote = decision?.note ?? null;
        agent.turn = decision?.turn ?? agent.turn;
        agent.memoryDepth = decision?.memory ?? agent.memoryDepth;
        if (decision?.chat) this.say(agent, decision.chat);

        const proposed = buildQueue(decision?.actions, agent);

        // Obedience is the model's job: it holds its orders in a cached system
        // prompt and remembers its own past turns. HARD_RULES.enforce brings back a
        // mechanical backstop for brains that cannot read a prompt at all.
        const { actions, refused } = HARD_RULES.enforce
          ? enforce(proposed, agent.participant.constraints)
          : { actions: proposed, refused: [] };
        agent.queue = actions;
        agent.lastActions = actions.map(describeAction);
        agent.lastRefused = refused;

        for (const reason of refused) {
          agent.pendingEvents.push(`Refused: ${reason}. That action did not happen.`);
        }

        if (!actions.length) {
          // Nothing usable came back, or the rules forbade all of it. `forced`
          // keeps this idle beat itself exempt from the rules.
          agent.queue = [{ type: 'hold', remaining: 0.4, total: 0.4, forced: true }];
          agent.lastActions = [refused.length ? 'idle (all actions refused)' : 'hold 0.4s (no action returned)'];
        }
        agent.pendingEvents.splice(0, consumedEvents);
      })
      .catch((error) => {
        if (token !== agent.thinkToken || !agent.alive) return;
        agent.thinking = false;
        const message = error?.message ?? String(error);
        agent.lastError = message;
        agent.participant.lastError = message;
        agent.queue = [{ type: 'hold', remaining: 1, total: 1 }];
        agent.lastActions = ['hold 1s (brain error)'];
        this.addLog(`${agent.name}: brain error - ${message}`, 'error');
      });
  }

  stepAgent(agent, dt) {
    if (!agent.alive) return;
    agent.blocked = false;

    // Finished reloads are applied even if the plan moved on.
    if (agent.reloadUntil && this.time >= agent.reloadUntil) {
      const weapon = WEAPONS[agent.weapon] ?? WEAPONS.pistol;
      if (agent.ammo < weapon.magazine && agent.current?.type === 'reload') agent.ammo = weapon.magazine;
      agent.reloadUntil = 0;
    }

    if (!agent.current) {
      if (agent.queue.length) {
        agent.current = agent.queue.shift();
      } else if (!agent.thinking) {
        this.requestDecision(agent);
        return;
      } else {
        return;   // still deliberating - the body just stands and watches
      }
    }

    const ctx = {
      now: this.time,
      tryMove: (a, dx, dy) => this.tryMove(a, dx, dy),
      fireWeapon: (a) => this.fireWeapon(a),
      pulse: (a, kind) => this.pulse(a, kind),
    };

    const finished = stepAction(agent, agent.current, dt, ctx);
    if (agent.blocked) agent.pendingEvents.push('Your walk was blocked by a wall.');
    if (finished) {
      this.recordOutcome(agent, agent.current);
      agent.current = null;
    }
  }

  /** Note what an action actually achieved, for the agent's own memory. */
  recordOutcome(agent, action, options) {
    if (!action || action.forced) return;
    agent.planResults.push({
      id: action.id ?? null,
      action: describeAction(action),
      outcome: describeOutcome(action, options),
    });
    if (agent.planResults.length > 12) agent.planResults.shift();
  }

  // ---------------------------------------------------------------- main tick

  update(dt) {
    if (this.paused) return;
    this.time += dt;
    this.tickCount += 1;

    for (const agent of [...this.agents]) this.stepAgent(agent, dt);
    this.stepProjectiles(dt);
    this.stepLoot(dt);
    this.lobby.update();

    this.effects = this.effects.filter((e) => e.until > this.time);
    for (const agent of this.agents) {
      if (agent.pendingEvents.length > 12) agent.pendingEvents.splice(0, agent.pendingEvents.length - 12);
    }
  }
}
