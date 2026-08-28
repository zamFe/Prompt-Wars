// The offline brain.
//
// It reads the player's prompt for intent - how aggressive, how greedy for
// loot, what range it wants to fight at, when to run - and drives a small state
// machine from those traits. It is not a language model, but it is driven
// entirely by the prompt text, so writing a better prompt still wins games.

import { MOVE, WEAPONS, AGENT, WORLD } from '../config.js';
import { clamp, toDeg, makeRng } from '../util.js';

/** Keyword -> trait nudges. Each entry may push several traits at once. */
const RULES = [
  // --- posture -------------------------------------------------------------
  { re: /\b(aggressiv\w*|attack|hunt|rush|charge|berserk|relentless|kill|hostile|push|brawl)\b/g, aggression: +0.22 },
  { re: /\b(defensiv\w*|cautious|careful|patient|passive|avoid|survive|coward\w*|timid)\b/g, aggression: -0.2, caution: +0.2 },
  { re: /\b(camp|ambush|lurk|wait|hide|hold position|stay put|guard)\b/g, aggression: -0.08, camp: +0.35 },
  { re: /\b(patrol|roam|wander|explore|search|sweep|scout)\b/g, camp: -0.25, roam: +0.3 },
  { re: /\b(spin|rotate|whirl|360|pirouette)\b/g, spin: +0.5 },

  // --- range preference ----------------------------------------------------
  { re: /\b(close range|point.?blank|up close|in their face|melee|hug|close the distance)\b/g, range: -0.4 },
  { re: /\b(long range|from afar|at distance|snip\w*|keep away|keep your distance|kite|poke)\b/g, range: +0.4 },

  // --- loot ----------------------------------------------------------------
  { re: /\b(heal|health|medkit|med.?pack|hp|first aid)\b/g, loot: +0.18 },
  { re: /\b(loot|pick ?up|grab|collect|scavenge|gather|item)\b/g, loot: +0.2 },
  { re: /\b(ignore (the )?(loot|items|pickups|health))\b/g, loot: -0.6 },

  // --- weapon preference ---------------------------------------------------
  { re: /\bshotgun\b/g, wantWeapon: 'shotgun', range: -0.15 },
  { re: /\b(assault rifle|\bar\b|rifle|full.?auto)\b/g, wantWeapon: 'assault' },

  // --- trigger discipline --------------------------------------------------
  { re: /\b(spray|dump|unload|empty the mag|full.?auto|suppress)\b/g, trigger: +0.4 },
  { re: /\b(conserve|save ammo|single shot|one shot at a time|disciplined|precise|accurate)\b/g, trigger: -0.35 },
  { re: /\b(burst)\b/g, trigger: +0.1 },

  // --- turning bias --------------------------------------------------------
  { re: /\b(clockwise|turn right|to the right|rightward)\b/g, turnBias: 'right' },
  { re: /\b(counter.?clockwise|anti.?clockwise|turn left|to the left|leftward)\b/g, turnBias: 'left' },

  // --- misc ---------------------------------------------------------------
  { re: /\b(never (retreat|run|flee)|fight to the death|no retreat|last stand)\b/g, retreatOverride: 0 },
  { re: /\b(always reload|reload (early|often|whenever))\b/g, eagerReload: +0.5 },
];

/** Pull an explicit HP threshold out of phrasings like "retreat below 40 hp". */
function parseHpThreshold(text) {
  const patterns = [
    /(?:below|under|less than|beneath|<)\s*(\d{1,3})\s*(?:%|hp|health)?/i,
    /(?:at or below|at)\s*(\d{1,3})\s*(?:%|hp|health)\b/i,
    /(\d{1,3})\s*(?:%|hp|health)\s*(?:or (?:less|lower|below))/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) {
      const value = Number(match[1]);
      if (value >= 1 && value <= 100) return value;
    }
  }
  return null;
}

export function parsePrompt(text = '') {
  const lower = ` ${String(text).toLowerCase()} `;
  const traits = {
    aggression: 0.5,
    caution: 0.2,
    camp: 0.15,
    roam: 0.3,
    spin: 0,
    range: 0,          // -1 wants to be close, +1 wants to stay far
    loot: 0.35,
    trigger: 0,        // -1 conserve ammo, +1 spray
    turnBias: null,
    wantWeapon: null,
    eagerReload: 0,
    retreatOverride: null,
  };

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    const hits = (lower.match(rule.re) ?? []).length;
    if (!hits) continue;
    const weight = Math.min(hits, 3);
    for (const [key, value] of Object.entries(rule)) {
      if (key === 're') continue;
      if (typeof value === 'number') traits[key] = clamp(traits[key] + value * weight, -1, 1);
      else traits[key] = value;
    }
  }

  traits.aggression = clamp(traits.aggression, 0.05, 1);
  traits.loot = clamp(traits.loot, 0, 1);

  const explicit = parseHpThreshold(lower);
  traits.retreatAt =
    traits.retreatOverride === 0 ? 0 : explicit ?? Math.round(clamp(58 - traits.aggression * 45 + traits.caution * 25, 0, 85));

  traits.turnBias ??= lower.includes('left') ? 'left' : 'right';
  traits.preferredDistance = Math.round(clamp(330 + traits.range * 260, 90, 600));
  return traits;
}

const nearestEnemy = (s) => (s.enemies.length ? s.enemies[0] : null);

/** Aim tolerance that actually corresponds to hitting a body of this size. */
function aimTolerance(distance, weaponId) {
  const angular = toDeg(Math.atan2(WORLD.agentRadius * 0.9, Math.max(40, distance)));
  const weaponBonus = weaponId === 'shotgun' ? 3 : 0;
  return clamp(angular + weaponBonus, 1.5, 20);
}

/**
 * Line the gun up with `bearing`. What matters is where the *gun* points, which
 * is body facing plus aim offset - so the error to close is `bearing - aimOffset`,
 * not the bearing itself. Returns [] when the shot is already on target.
 */
function alignTo(bearing, s, tolerance) {
  const error = bearing - s.self.aimOffset;
  if (Math.abs(error) <= tolerance) return [];

  if (Math.abs(bearing) <= MOVE.aimLimit) {
    return [{ name: 'aim', input: { direction: bearing < 0 ? 'left' : 'right', degrees: Math.abs(bearing) } }];
  }
  // Beyond the aim cone the body has to come round. Turn far enough that the
  // remainder falls inside the aim cone, so the next decision can finish the job.
  const turn = Math.abs(bearing) - MOVE.aimLimit * 0.5;
  return [{ name: 'turn', input: { direction: bearing < 0 ? 'left' : 'right', degrees: clamp(turn, 5, 180) } }];
}

/** Pick the most open bearing from the wall probes across the cone. */
function openestBearing(s) {
  let best = s.walls.cone[0];
  for (const ray of s.walls.cone) if (ray.distance > best.distance) best = ray;
  return best;
}

function shotsToFire(s, traits) {
  if (s.self.ammo <= 0) return 0;
  if (traits.trigger > 0.25) return Math.min(s.self.ammo, s.self.weaponId === 'assault' ? 5 : 3);
  if (traits.trigger < -0.2) return 1;
  return Math.min(s.self.ammo, 2);
}

export function decideFromTraits(s, traits, rng) {
  const actions = [];
  const enemy = nearestEnemy(s);
  const hpFraction = s.self.hp / s.self.maxHp;
  let note;

  // --- housekeeping --------------------------------------------------------
  if (s.self.reloading) {
    return { actions: [{ name: 'hold', input: { seconds: 0.5 } }], note: 'waiting out reload' };
  }

  if (s.self.ammo <= 0) {
    // Reload behind cover if something is shooting at us.
    if (enemy && enemy.distance < 260) {
      return {
        actions: [
          { name: 'move', input: { direction: 'backward', steps: 3 } },
          { name: 'reload', input: {} },
        ],
        note: 'dry - backing off to reload',
      };
    }
    return { actions: [{ name: 'reload', input: {} }], note: 'reloading' };
  }

  const magazine = WEAPONS[s.self.weaponId]?.magazine ?? 3;
  if (!enemy && traits.eagerReload > 0.2 && s.self.ammo < magazine) {
    return { actions: [{ name: 'reload', input: {} }], note: 'topping up while clear' };
  }

  // --- fight ---------------------------------------------------------------
  if (enemy) {
    const tolerance = aimTolerance(enemy.distance, s.self.weaponId);
    const wantsOut = traits.retreatAt > 0 && s.self.hp <= traits.retreatAt;

    if (wantsOut) {
      note = `HP ${s.self.hp} at or below retreat threshold ${traits.retreatAt}`;
      if (enemy.distance < 320) {
        actions.push(...alignTo(enemy.bearing, s, tolerance));
        actions.push({ name: 'fire', input: { shots: 1 } });
        actions.push({ name: 'move', input: { direction: 'backward', steps: 4 } });
      } else {
        actions.push({ name: 'turn', input: { direction: traits.turnBias, degrees: 130 } });
        actions.push({ name: 'move', input: { direction: 'forward', steps: 6 } });
      }
      return { actions, note };
    }

    const align = alignTo(enemy.bearing, s, tolerance);
    actions.push(...align);

    const lined = align.length === 0;
    if (lined && s.self.canFireNow) {
      const shots = shotsToFire(s, traits);
      if (shots > 0) actions.push({ name: 'fire', input: { shots } });
      note = `engaging ${enemy.name} at ${enemy.distance}`;
    } else {
      note = `lining up on ${enemy.name}`;
    }

    // Close or open the gap toward the preferred fighting distance.
    const gap = enemy.distance - traits.preferredDistance;
    if (gap > 90 && lined) {
      actions.push({ name: 'move', input: { direction: 'forward', steps: clamp(Math.round(gap / MOVE.stepDistance), 1, 5) } });
    } else if (gap < -90) {
      actions.push({ name: 'move', input: { direction: 'backward', steps: clamp(Math.round(-gap / MOVE.stepDistance), 1, 4) } });
    }
    return { actions, note };
  }

  // --- loot ----------------------------------------------------------------
  const wantsHealth = hpFraction < 0.95;
  const target = s.loot.find((item) => {
    if (item.kind === 'health') return wantsHealth && (hpFraction < 0.6 || traits.loot > 0.3);
    if (traits.wantWeapon) return item.label.toLowerCase().includes(traits.wantWeapon === 'assault' ? 'assault' : 'shotgun');
    return traits.loot > 0.25;
  });

  if (target) {
    actions.push(...alignTo(target.bearing, s, 4));
    const steps = clamp(Math.round(target.distance / MOVE.stepDistance), 1, 8);
    actions.push({ name: 'move', input: { direction: 'forward', steps } });
    return { actions, note: `collecting ${target.label}` };
  }

  // --- nothing in sight: search -------------------------------------------
  const ahead = s.walls.proximity.front;
  if (ahead < 70) {
    const open = openestBearing(s);
    const away = open.distance > 200 ? open.bearing : (traits.turnBias === 'left' ? -110 : 110);
    return {
      actions: [
        { name: 'turn', input: { direction: away < 0 ? 'left' : 'right', degrees: clamp(Math.abs(away), 25, 180) } },
        { name: 'move', input: { direction: 'forward', steps: 3 } },
      ],
      note: 'wall ahead, turning away',
    };
  }

  if (traits.spin > 0.3) {
    return {
      actions: [{ name: 'turn', input: { direction: traits.turnBias, degrees: 60 } }],
      note: 'spinning to scan',
    };
  }

  if (traits.camp > 0.3 && rng() > traits.roam) {
    return {
      actions: [
        { name: 'turn', input: { direction: rng() < 0.5 ? 'left' : 'right', degrees: 22 + rng() * 25 } },
        { name: 'hold', input: { seconds: 0.8 + rng() * 1.2 } },
      ],
      note: 'holding position, watching',
    };
  }

  const sweep = 25 + rng() * 45;
  const direction = rng() < 0.72 ? traits.turnBias : traits.turnBias === 'left' ? 'right' : 'left';
  return {
    actions: [
      { name: 'turn', input: { direction, degrees: sweep } },
      { name: 'move', input: { direction: 'forward', steps: 2 + Math.floor(rng() * 4) } },
    ],
    note: 'searching',
  };
}

/** Brain object consumed by the world. */
export function createLocalBrain({ thinkTime = [0.25, 0.6] } = {}) {
  const cache = new WeakMap();

  return {
    id: 'local',
    label: 'Offline (prompt interpreter)',

    traitsFor(participant) {
      let entry = cache.get(participant);
      if (!entry || entry.prompt !== participant.prompt) {
        entry = {
          prompt: participant.prompt,
          traits: parsePrompt(participant.prompt),
          rng: makeRng([...participant.id].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)),
        };
        cache.set(participant, entry);
      }
      return entry;
    },

    async decide(snapshot, participant) {
      const entry = this.traitsFor(participant);
      // A small delay so offline agents feel like they are deciding, not twitching.
      const delay = thinkTime[0] + entry.rng() * (thinkTime[1] - thinkTime[0]);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      return decideFromTraits(snapshot, entry.traits, entry.rng);
    },
  };
}
