// The arena: a square with a handful of interior walls, plus the geometry
// queries the simulation and the sensors need (line of sight, collision).

import { WORLD } from './config.js';
import { clamp, dist, rayRect, closestPointOnRect, randRange } from './util.js';

const S = WORLD.size;

/**
 * Interior cover. Deliberately sparse - enough to break sightlines and reward
 * an agent that maps the room with its wall probes, not so much that it plays
 * like a maze.
 */
export const WALLS = [
  { x: 500, y: 660, w: 400, h: 80 },   // centre bar
  { x: 300, y: 250, w: 80, h: 320 },   // north-west upright
  { x: 1020, y: 830, w: 80, h: 320 },  // south-east upright
  { x: 830, y: 300, w: 300, h: 80 },   // north-east bar
  { x: 270, y: 1020, w: 300, h: 80 },  // south-west bar
  { x: 655, y: 300, w: 90, h: 90 },    // north pillar
  { x: 655, y: 1010, w: 90, h: 90 },   // south pillar
];

/** Border walls, kept separate so they can be drawn differently. */
export const BORDER_THICKNESS = 24;

export function isInsideArena(x, y, radius = 0) {
  const lo = BORDER_THICKNESS + radius;
  const hi = S - BORDER_THICKNESS - radius;
  return x >= lo && x <= hi && y >= lo && y <= hi;
}

/** Distance from (x, y) to the nearest wall surface, borders included. */
export function clearance(x, y) {
  let best = Math.min(
    x - BORDER_THICKNESS,
    y - BORDER_THICKNESS,
    S - BORDER_THICKNESS - x,
    S - BORDER_THICKNESS - y,
  );
  for (const wall of WALLS) {
    const c = closestPointOnRect(x, y, wall);
    const d = dist(x, y, c.x, c.y);
    // Inside a wall counts as no clearance at all.
    const inside =
      x > wall.x && x < wall.x + wall.w && y > wall.y && y < wall.y + wall.h;
    best = Math.min(best, inside ? -1 : d);
  }
  return best;
}

/**
 * Cast a ray and return the distance to the first wall hit (borders included),
 * capped at `maxDistance`.
 */
export function castRay(ox, oy, dirX, dirY, maxDistance) {
  let best = maxDistance;

  // Border planes.
  const lo = BORDER_THICKNESS;
  const hi = S - BORDER_THICKNESS;
  if (dirX > 1e-9) best = Math.min(best, (hi - ox) / dirX);
  if (dirX < -1e-9) best = Math.min(best, (lo - ox) / dirX);
  if (dirY > 1e-9) best = Math.min(best, (hi - oy) / dirY);
  if (dirY < -1e-9) best = Math.min(best, (lo - oy) / dirY);

  for (const wall of WALLS) {
    const t = rayRect(ox, oy, dirX, dirY, wall);
    if (t < best) best = t;
  }
  return Math.max(0, best);
}

/** True when nothing solid stands between the two points. */
export function hasLineOfSight(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return true;
  const hit = castRay(ax, ay, dx / len, dy / len, len);
  return hit >= len - 0.5;
}

/**
 * Push a circle out of any wall it overlaps. Returns the corrected position and
 * whether a correction was needed, which the agent reports as "blocked".
 */
export function resolveCollision(x, y, radius) {
  let nx = x;
  let ny = y;
  let blocked = false;

  const lo = BORDER_THICKNESS + radius;
  const hi = S - BORDER_THICKNESS - radius;
  if (nx < lo) { nx = lo; blocked = true; }
  if (nx > hi) { nx = hi; blocked = true; }
  if (ny < lo) { ny = lo; blocked = true; }
  if (ny > hi) { ny = hi; blocked = true; }

  // Two passes so a corner between two walls settles instead of oscillating.
  for (let pass = 0; pass < 2; pass++) {
    for (const wall of WALLS) {
      const c = closestPointOnRect(nx, ny, wall);
      const dx = nx - c.x;
      const dy = ny - c.y;
      const d = Math.hypot(dx, dy);

      if (d >= radius) continue;
      blocked = true;

      if (d > 1e-6) {
        nx = c.x + (dx / d) * radius;
        ny = c.y + (dy / d) * radius;
      } else {
        // Centre is inside the wall - eject along the shallowest axis.
        const left = nx - wall.x;
        const right = wall.x + wall.w - nx;
        const top = ny - wall.y;
        const bottom = wall.y + wall.h - ny;
        const min = Math.min(left, right, top, bottom);
        if (min === left) nx = wall.x - radius;
        else if (min === right) nx = wall.x + wall.w + radius;
        else if (min === top) ny = wall.y - radius;
        else ny = wall.y + wall.h + radius;
      }
    }
  }
  return { x: nx, y: ny, blocked };
}

/**
 * Find an open spot, preferring one that is far from every listed avoid-point
 * (other agents at spawn time). Falls back to the best of many tries.
 */
export function findOpenPosition(rng, { radius = WORLD.agentRadius, avoid = [], minAvoidDistance = 240 } = {}) {
  let fallback = null;
  let fallbackScore = -Infinity;

  for (let attempt = 0; attempt < 120; attempt++) {
    const x = randRange(rng, BORDER_THICKNESS + radius + 10, S - BORDER_THICKNESS - radius - 10);
    const y = randRange(rng, BORDER_THICKNESS + radius + 10, S - BORDER_THICKNESS - radius - 10);
    if (clearance(x, y) < radius + 12) continue;

    let nearest = Infinity;
    for (const p of avoid) nearest = Math.min(nearest, dist(x, y, p.x, p.y));

    if (nearest >= minAvoidDistance) return { x, y };
    if (nearest > fallbackScore) {
      fallbackScore = nearest;
      fallback = { x, y };
    }
  }
  return fallback ?? { x: S / 2, y: S / 2 };
}

export const arenaSize = S;
export const clampToArena = (v, radius) =>
  clamp(v, BORDER_THICKNESS + radius, S - BORDER_THICKNESS - radius);
