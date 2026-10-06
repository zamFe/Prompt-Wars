// Hearing.
//
// Sight in this arena is a 45-degree cone: an agent is blind to almost
// everything around it. Sound is the other half of the picture, and the only
// sense that reaches behind you. A gunshot or a shout tells you SOMETHING
// happened and roughly where - never what, never how far.
//
// What a listener gets is one of eight directions RELATIVE TO ITS OWN FACING,
// with its own nose as north: N is dead ahead, E is its right, S is behind it,
// W is its left. That is deliberately the same mental model as the bearings it
// already reads, and it costs an agent nothing to act on - turn W and look.
//
// Walls muffle rather than block. Sound going round a corner is the whole
// reason this sense is worth having.

import { SOUND } from './config.js';
import { hasLineOfSight } from './arena.js';
import { normalizeDeg, toDeg } from './util.js';

/** Eight sectors, starting at dead ahead and going clockwise. */
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Which way a point lies, in the listener's own frame. Its facing is north.
 *
 * The bearing is worked out here rather than borrowed from sensors.js, which
 * reads sound back out again - one of them has to not import the other.
 */
export function compassFrom(listener, x, y) {
  const absolute = toDeg(Math.atan2(y - listener.y, x - listener.x));
  const bearing = normalizeDeg(absolute - listener.facing);
  return POINTS[((Math.round(bearing / 45) % 8) + 8) % 8];
}

/** How far a sound of this kind carries, before anything is in the way. */
const rangeFor = (kind) => (kind === 'shot' ? SOUND.shotRange : SOUND.speechRange);

/**
 * Raise a sound at a point, and give it to everyone close enough to hear it.
 *
 * Delivered on the spot rather than stored and queried every tick: there are at
 * most ten listeners, and a sound that nobody heard should cost nothing to
 * forget.
 */
export function emitSound(world, { kind, x, y, source = null, name = null, text = null }) {
  const reach = rangeFor(kind);

  // In commander mode a side talks over its own channel: a squad hears its
  // commander wherever they both are, and the commander hears its squad. The
  // other side still only hears what carries through the air.
  const radio = kind === 'speech' && Boolean(world.match?.mode?.teamComms) && Boolean(source?.team);

  for (const listener of world.agents) {
    if (!listener.alive || listener === source) continue;

    const distance = Math.hypot(listener.x - x, listener.y - y);
    const onChannel = radio && listener.team === source.team;
    const muffled = !onChannel && !hasLineOfSight(listener.x, listener.y, x, y);

    if (!onChannel) {
      if (distance > reach) continue;
      // A wall between you and it costs range rather than silencing it.
      if (muffled && distance > reach * SOUND.wallDamping) continue;
    }

    listener.heard ??= [];
    listener.heard.push({
      kind,
      direction: compassFrom(listener, x, y),
      muffled,
      radio: onChannel,
      name,
      text,
      at: world.time,
    });
    // Only the most recent handful survives to the next decision: an agent in a
    // firefight should not be handed a minute of bangs to read.
    if (listener.heard.length > SOUND.maxHeard) listener.heard.shift();
  }
}

/** What this agent has heard since it last thought, oldest first. */
export function takeHeard(agent, now) {
  const all = agent.heard ?? [];
  if (!all.length) return [];
  const fresh = all.filter((sound) => now - sound.at <= SOUND.memory);
  agent.heard = [];
  return fresh;
}

/**
 * The same list as a line an agent reads. Repeats are folded together, because
 * "gunshot to your E" six times is one fact, not six.
 */
export function describeHeard(heard = []) {
  if (!heard.length) return [];

  const lines = [];
  const shots = new Map();

  for (const sound of heard) {
    if (sound.kind === 'shot') {
      shots.set(sound.direction, (shots.get(sound.direction) ?? 0) + 1);
    } else {
      lines.push(
        `  ${sound.name ?? 'A voice'} ${sound.radio ? 'on your channel, from your' : 'to your'} ${sound.direction}` +
          `${sound.muffled ? ' (muffled, through cover)' : ''}: "${sound.text ?? '...'}"`,
      );
    }
  }

  for (const [direction, count] of shots) {
    lines.push(`  ${count === 1 ? 'A gunshot' : `${count} gunshots`} to your ${direction}`);
  }
  return lines;
}
