// Math, geometry and RNG helpers shared by the simulation.

export const TAU = Math.PI * 2;

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Wrap an angle in degrees into [-180, 180). */
export function normalizeDeg(deg) {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (Object.is(d, -0)) d = 0;
  return d;
}

/** Smallest signed rotation in degrees that takes `from` to `to`. */
export const angleDelta = (from, to) => normalizeDeg(to - from);

export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

export const randRange = (rng, lo, hi) => lo + rng() * (hi - lo);
export const randInt = (rng, lo, hi) => Math.floor(randRange(rng, lo, hi + 1));

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Weighted pick from a { key: weight } map. */
export function weightedPick(rng, weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [key, w] of entries) {
    roll -= w;
    if (roll <= 0) return key;
  }
  return entries.length ? entries[entries.length - 1][0] : null;
}

/** mulberry32 - small, fast, seedable PRNG so matches can be reproduced. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ray vs axis-aligned rectangle (slab method).
 * Returns the distance along the ray to the first hit, or Infinity.
 */
export function rayRect(ox, oy, dx, dy, rect) {
  let tmin = 0;
  let tmax = Infinity;

  for (const axis of [0, 1]) {
    const o = axis === 0 ? ox : oy;
    const d = axis === 0 ? dx : dy;
    const lo = axis === 0 ? rect.x : rect.y;
    const hi = axis === 0 ? rect.x + rect.w : rect.y + rect.h;

    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return Infinity;
  }
  return tmin;
}

/** Closest point on an axis-aligned rect to (px, py). */
export function closestPointOnRect(px, py, rect) {
  return {
    x: clamp(px, rect.x, rect.x + rect.w),
    y: clamp(py, rect.y, rect.y + rect.h),
  };
}

export function circleHitsRect(px, py, radius, rect) {
  const c = closestPointOnRect(px, py, rect);
  return dist(px, py, c.x, c.y) < radius;
}

/** Shortest distance from point p to segment ab - used for bullet/agent sweeps. */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) return dist(px, py, ax, ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = clamp(t, 0, 1);
  return dist(px, py, ax + abx * t, ay + aby * t);
}

export const round1 = (n) => Math.round(n * 10) / 10;
export const round0 = (n) => Math.round(n);

export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
