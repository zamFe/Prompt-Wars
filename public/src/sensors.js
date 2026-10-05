// Everything an agent knows about the world.
//
// Agents never receive absolute arena coordinates. They get a compass heading,
// bearings and distances to what is inside their vision cone, and wall probes -
// so working out where you are is itself part of the prompt's job.

import { VISION, MOVE, WEAPONS, AGENT, WORLD, TEAMS } from './config.js';
import { normalizeDeg, toRad, dist, round0, round1, clamp } from './util.js';
import { castRay, hasLineOfSight } from './arena.js';
import { takeHeard, describeHeard } from './sound.js';

/** Internal facing (0 = east, clockwise) to a compass heading (0 = north). */
export const toCompass = (facing) => (Math.round(normalizeDeg(facing + 90)) + 360) % 360;

export const compassLabel = (heading) => {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(heading / 45) % 8];
};

/** Bearing from `agent` to a world point, in degrees relative to its body facing. */
export function bearingTo(agent, x, y) {
  const absolute = (Math.atan2(y - agent.y, x - agent.x) * 180) / Math.PI;
  return normalizeDeg(absolute - agent.facing);
}

const inCone = (bearing) => Math.abs(bearing) <= VISION.fov / 2;

/**
 * Wall probes fanned across the vision cone, plus four short-range proximity
 * senses. The cone probes let an agent read the room ahead; the proximity
 * senses are a touch sense for what is immediately around it.
 */
function senseWalls(agent) {
  const cone = [];
  const half = VISION.fov / 2;
  const count = VISION.wallRays;

  for (let i = 0; i < count; i++) {
    const bearing = -half + (i * VISION.fov) / (count - 1);
    const rad = toRad(agent.facing + bearing);
    const d = castRay(agent.x, agent.y, Math.cos(rad), Math.sin(rad), VISION.range);
    cone.push({ bearing: round1(bearing), distance: round0(d) });
  }

  const probe = (offset) => {
    const rad = toRad(agent.facing + offset);
    return round0(castRay(agent.x, agent.y, Math.cos(rad), Math.sin(rad), 400));
  };

  return {
    cone,
    proximity: { front: probe(0), right: probe(90), back: probe(180), left: probe(-90) },
  };
}

function seesTarget(agent, x, y, radius) {
  const bearing = bearingTo(agent, x, y);
  const d = dist(agent.x, agent.y, x, y);
  // A target is visible if its centre is in the cone, or it is close enough that
  // its edge clips the cone - stops large pickups popping in and out at the seam.
  const edgeSlack = d > 1 ? (Math.atan2(radius, d) * 180) / Math.PI : 90;
  if (Math.abs(bearing) > VISION.fov / 2 + edgeSlack) return null;
  if (d > VISION.range) return null;
  if (!hasLineOfSight(agent.x, agent.y, x, y)) return null;
  return { bearing, distance: d };
}

/** How an enemy is oriented: 0 means looking straight back at you. */
function relativeFacing(agent, other) {
  const towardMe = (Math.atan2(agent.y - other.y, agent.x - other.x) * 180) / Math.PI;
  return normalizeDeg(towardMe - other.facing);
}

function facingWord(relative) {
  const a = Math.abs(relative);
  if (a <= 25) return 'facing you';
  if (a <= 70) return relative < 0 ? 'turned slightly right of you' : 'turned slightly left of you';
  if (a <= 120) return relative < 0 ? 'side-on, right' : 'side-on, left';
  return 'facing away from you';
}

/**
 * Build the snapshot handed to a brain. `world` supplies live agents and loot.
 */
export function buildSnapshot(agent, world) {
  const weapon = WEAPONS[agent.weapon] ?? WEAPONS.pistol;
  const heading = toCompass(agent.facing);

  const teamMode = Boolean(world.match?.isTeamMode);
  const enemies = [];
  const allies = [];

  for (const other of world.agents) {
    if (other === agent || !other.alive) continue;
    const seen = seesTarget(agent, other.x, other.y, WORLD.agentRadius);
    if (!seen) continue;
    const rel = relativeFacing(agent, other);
    const friendly = teamMode && agent.team && other.team === agent.team;
    (friendly ? allies : enemies).push({
      name: other.name,
      carrying: other.carrying ? true : false,
      bearing: round1(seen.bearing),
      distance: round0(seen.distance),
      // Relative position, in your own frame: how far ahead and how far to your right.
      forward: round0(Math.cos(toRad(seen.bearing)) * seen.distance),
      right: round0(Math.sin(toRad(seen.bearing)) * seen.distance),
      heading: toCompass(other.facing),
      orientation: facingWord(rel),
      hp: round0(other.hp),
      weapon: (WEAPONS[other.weapon] ?? WEAPONS.pistol).name,
    });
  }
  enemies.sort((a, b) => a.distance - b.distance);
  allies.sort((a, b) => a.distance - b.distance);

  const loot = [];
  for (const item of world.pickups) {
    const seen = seesTarget(agent, item.x, item.y, item.radius);
    if (!seen) continue;
    loot.push({
      kind: item.kind,
      label: item.label,
      bearing: round1(seen.bearing),
      distance: round0(seen.distance),
    });
  }
  loot.sort((a, b) => a.distance - b.distance);

  const walls = senseWalls(agent);
  const reloading = agent.reloadUntil > world.time;

  return {
    tick: world.tickCount,
    time: round1(world.time),
    self: {
      name: agent.name,
      hp: round0(agent.hp),
      maxHp: AGENT.maxHp,
      weapon: weapon.name,
      weaponId: weapon.id,
      ammo: agent.ammo,
      magazine: weapon.magazine,
      reloading,
      canFireNow: !reloading && agent.ammo > 0 && agent.nextShotAt <= world.time,
      heading,
      headingLabel: compassLabel(heading),
      aimOffset: round1(agent.aimOffset),
    },
    vision: { fovDegrees: VISION.fov, range: VISION.range },
    mission: buildMission(agent, world),
    objective: buildObjective(agent, world),
    enemies,
    allies,
    loot,
    walls,
    // Things that happened since this agent's previous decision.
    events: agent.pendingEvents.slice(-6),
    // And things it heard happen, which is the only sense it has behind itself.
    heard: takeHeard(agent, world.time),
    arena: {
      agentsAlive: world.agents.filter((a) => a.alive).length,
      queueLength: world.queue.length,
    },
  };
}

/**
 * What game this is, which side you are on, and how it stands. An agent that
 * does not know the score cannot play to it.
 */
function buildMission(agent, world) {
  const match = world.match;
  if (!match) return null;
  const mode = match.mode;
  const mine = agent.team;
  const scores = match.scores;

  return {
    mode: mode.id,
    modeName: mode.name,
    scoreWord: mode.scoreWord,
    team: mine,
    teamName: mine ? TEAMS[mine].name : null,
    yourScore: mine ? scores[mine] : (agent.participant.kills ?? 0),
    theirScore: mine ? scores[mine === 'a' ? 'b' : 'a'] : null,
    livesLeft: Number.isFinite(agent.participant.livesLeft) ? agent.participant.livesLeft : null,
    secondsLeft: match.remaining === null ? null : Math.round(match.remaining),
  };
}

/**
 * The flags, in a mode that has them.
 *
 * A team always knows where its own flag is - that is its own flag, and its own
 * people are watching it. It knows the STATE of the enemy flag too, because
 * taking one is not a quiet act. Where the enemy flag physically is, though, it
 * only knows by seeing it, or by carrying it.
 */
function buildObjective(agent, world) {
  if (!agent.team) return null;
  // Every team mode has two bases; only capture the flag has flags standing on
  // them. Without this, a team deathmatch gives an agent no sense of direction
  // at all and both sides sit at home for ten minutes.
  const flags = world.match?.flags ?? null;

  const mine = flags?.[agent.team] ?? null;
  const theirs = flags?.[agent.team === 'a' ? 'b' : 'a'] ?? null;
  // Both bases are known. You were briefed on the map before you walked in -
  // not knowing where the enemy keeps its flag would make the mode unplayable
  // behind a 45-degree cone, and would not be realistic either.
  const home = world.match.baseFor?.(agent.team) ?? null;
  const away = world.match.baseFor?.(agent.team === 'a' ? 'b' : 'a') ?? null;

  const place = (x, y) => ({
    bearing: round1(bearingTo(agent, x, y)),
    distance: round0(dist(agent.x, agent.y, x, y)),
  });

  const theirsVisible = Boolean(theirs) &&
    (Boolean(seesTarget(agent, theirs.x, theirs.y, 18)) || theirs.carrier === agent.id);

  return {
    carrying: Boolean(theirs) && agent.carrying === theirs.team,
    yourFlag: mine ? { state: mine.state, ...place(mine.x, mine.y), known: true } : null,
    enemyFlag: theirs
      ? {
          state: theirs.state,
          known: theirsVisible,
          ...(theirsVisible ? place(theirs.x, theirs.y) : { bearing: null, distance: null }),
        }
      : null,
    yourBase: home ? place(home.x, home.y) : null,
    enemyBase: away ? place(away.x, away.y) : null,
  };
}

/**
 * Compact text rendering of a snapshot - what the Claude brain actually reads,
 * and what the inspector panel shows. Much cheaper than raw JSON and easier for
 * a human to sanity-check against the screen.
 */
export function renderSnapshotText(s) {
  const lines = [];
  lines.push(
    `T=${s.time}s  HP ${s.self.hp}/${s.self.maxHp}  ${s.self.weapon} ${s.self.ammo}/${s.self.magazine}` +
      `${s.self.reloading ? ' (RELOADING)' : ''}${s.self.canFireNow ? '' : ' (not ready)'}`,
  );
  lines.push(
    `Heading ${s.self.heading}° (${s.self.headingLabel})  aim offset ${s.self.aimOffset}°  ` +
      `vision ${s.vision.fovDegrees}° cone, ${s.vision.range} range`,
  );

  // The mission comes first: what you are playing, how it stands, what you
  // have left. An agent that does not know the score cannot play to it.
  if (s.mission) {
    const m = s.mission;
    const score = m.team
      ? `${m.teamName} ${m.yourScore} - ${m.theirScore} enemy (${m.scoreWord})`
      : `your ${m.scoreWord}: ${m.yourScore}`;
    lines.push(
      `MODE ${m.modeName.toUpperCase()}${m.team ? ` — you are ${m.teamName}` : ''}  |  ${score}` +
        `${m.livesLeft === null ? '' : `  |  lives left ${m.livesLeft}`}` +
        `${m.secondsLeft === null ? '' : `  |  ${m.secondsLeft}s on the clock`}`,
    );
  }

  if (s.objective) {
    const o = s.objective;
    const where = (f) => (!f || f.distance === null ? 'position unknown' : `bearing ${f.bearing > 0 ? '+' : ''}${f.bearing}°, distance ${f.distance}`);
    lines.push('OBJECTIVE:');
    if (o.yourFlag) {
      lines.push(`  You are ${o.carrying ? 'CARRYING THE ENEMY FLAG — get it to your base' : 'not carrying a flag'}.`);
      lines.push(`  Your flag: ${o.yourFlag.state}, ${where(o.yourFlag)}` +
        `${o.yourFlag.state === 'home' ? ' (at your base — a capture only counts while it is here)' : ''}`);
      lines.push(`  Enemy flag: ${o.enemyFlag.state}, ${where(o.enemyFlag)}`);
    }
    if (o.yourBase) lines.push(`  Your base: ${where(o.yourBase)}`);
    if (o.enemyBase) {
      lines.push(`  Enemy base: ${where(o.enemyBase)}` +
        `${o.enemyFlag ? ' (where their flag stands when it is home)' : ' (their side of the arena)'}`);
    }
  }

  if (s.allies?.length) {
    lines.push('TEAMMATES IN SIGHT (your fire passes through them):');
    for (const a of s.allies) {
      lines.push(
        `  ${a.name}: bearing ${a.bearing > 0 ? '+' : ''}${a.bearing}°, distance ${a.distance}, HP ${a.hp}` +
          `${a.carrying ? ' — CARRYING THE ENEMY FLAG' : ''}`,
      );
    }
  }

  if (s.enemies.length) {
    lines.push('ENEMIES IN SIGHT:');
    for (const e of s.enemies) {
      lines.push(
        `  ${e.name}: bearing ${e.bearing > 0 ? '+' : ''}${e.bearing}° ` +
          `(${e.bearing > 0 ? 'right' : e.bearing < 0 ? 'left' : 'dead ahead'}), distance ${e.distance}, ` +
          `${e.forward} ahead / ${Math.abs(e.right)} to your ${e.right >= 0 ? 'right' : 'left'}, ` +
          `HP ${e.hp}, ${e.weapon}, heading ${e.heading}° - ${e.orientation}` +
          `${e.carrying ? ' — CARRYING YOUR FLAG' : ''}`,
      );
    }
  } else {
    lines.push('ENEMIES IN SIGHT: none');
  }

  if (s.loot.length) {
    lines.push('LOOT IN SIGHT:');
    for (const l of s.loot) {
      lines.push(`  ${l.label}: bearing ${l.bearing > 0 ? '+' : ''}${l.bearing}°, distance ${l.distance}`);
    }
  } else {
    lines.push('LOOT IN SIGHT: none');
  }

  lines.push(
    'WALL DISTANCE ACROSS CONE (left to right): ' +
      s.walls.cone.map((w) => `${w.bearing > 0 ? '+' : ''}${w.bearing}°:${w.distance}`).join('  '),
  );
  const p = s.walls.proximity;
  lines.push(`WALL PROXIMITY: front ${p.front}, right ${p.right}, back ${p.back}, left ${p.left}`);

  const sounds = describeHeard(s.heard);
  if (sounds.length) {
    lines.push('WHAT YOU HEARD (direction is relative to your own facing: N is ahead, E your right, S behind, W your left):');
    lines.push(...sounds);
  }

  if (s.events.length) {
    lines.push('SINCE YOUR LAST DECISION:');
    for (const e of s.events) lines.push(`  - ${e}`);
  }
  return lines.join('\n');
}

export const senseUtils = { seesTarget, relativeFacing, facingWord, clamp };
