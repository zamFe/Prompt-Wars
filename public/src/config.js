// Central tuning table for Prompt Wars.
// Distances are in world units, times in seconds, angles in degrees.

export const WORLD = {
  size: 1400,          // arena is a square, size x size
  agentRadius: 16,
  maxAgents: 10,
  tickRate: 60,
};

export const MOVE = {
  turnSpeed: 100,      // body rotation, deg/sec
  aimSpeed: 160,       // aim offset rotation, deg/sec
  aimLimit: 35,        // aim may deviate this far from body facing
  stepDistance: 26,    // one "step" of move()
  forwardSpeed: 130,   // world units/sec
  backwardSpeed: 78,   // walking backwards is slower
  sidestepSpeed: 95,   // sidestepping keeps your cone and gun on target, so it
                       // costs ground speed - quicker than backing up, slower
                       // than walking where you are looking
};

export const VISION = {
  fov: 45,             // total cone width; agents see +/- 22.5 deg
  range: 620,
  wallRays: 9,         // wall-distance probes spread across the cone
};

// Damage is balanced against 100 HP.
//   pistol   : 3 shots / 4.25s cycle * 20 dmg  = ~14 dps, 5 hits to kill
//   assault  : 10 shots / 7.0s cycle * 15 dmg  = ~21 dps, 7 hits to kill
//   shotgun  : 5 shells / 8.0s cycle * 48 dmg  = ~30 dps up close, falls off hard
// The two pickup weapons out-damage the default, which is what makes loot worth
// crossing the arena for, but the shotgun only earns its number inside `falloffStart`.
export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    magazine: 3,
    timeBetweenShots: 0.75,
    reloadTime: 2.0,
    damage: 20,
    pellets: 1,
    spread: 1.5,
    bulletSpeed: 1400,
    range: 900,
    falloffStart: 900,
    falloffFloor: 1.0,
    color: '#e8e8f0',
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    magazine: 5,
    timeBetweenShots: 1.0,
    reloadTime: 3.0,
    damage: 8,
    pellets: 6,
    spread: 9,
    bulletSpeed: 1100,
    range: 520,
    falloffStart: 130,   // full damage inside this radius
    falloffFloor: 0.35,  // scales down to this at max range
    color: '#ffb347',
  },
  assault: {
    id: 'assault',
    name: 'Assault Rifle',
    magazine: 10,
    timeBetweenShots: 0.5,
    reloadTime: 2.0,
    damage: 15,
    pellets: 1,
    spread: 3,
    bulletSpeed: 1500,
    range: 1000,
    falloffStart: 700,
    falloffFloor: 0.75,
    color: '#5ec8ff',
  },
};

export const AGENT = {
  maxHp: 100,
  startWeapon: 'pistol',
};

// Health packs are read at a glance: bigger and brighter means more healing.
export const HEALTH_PACKS = {
  10: { heal: 10, radius: 7, color: '#7fdba0', label: 'S' },
  25: { heal: 25, radius: 10, color: '#38d97a', label: 'M' },
  50: { heal: 50, radius: 14, color: '#26f5c4', label: 'L' },
};

export const LOOT = {
  maxOnGround: 10,
  spawnCooldown: [6, 16],   // random range between spawns
  lifetime: 60,             // uncollected loot despawns
  // Relative spawn weights.
  weights: {
    health10: 26,
    health25: 20,
    health50: 8,
    shotgun: 13,
    assault: 11,
  },
};

export const LOBBY = {
  respawnCooldown: 60,          // seconds before a dead agent may rejoin
  congestedCooldown: 600,       // when the arena is full and the queue is long
  congestedQueueLength: 10,     // "queue > 10" triggers the long cooldown
};

export const BRAIN = {
  maxActionsPerDecision: 4,
  decisionTimeout: 12,          // seconds before a pending decision is abandoned
  localThinkTime: [0.25, 0.6],  // simulated deliberation for the offline brain
  damageInterruptCooldown: 0.6, // getting shot flushes the action queue, at most this often
};

export const COLORS = {
  background: '#0e1016',
  floor: '#161a24',
  grid: '#1e2432',
  wall: '#39415a',
  wallEdge: '#59627f',
};

// A palette of readable, well-separated sphere colors.
export const AGENT_COLORS = [
  '#ff5c7a', '#ffd166', '#4ade80', '#38bdf8', '#c084fc',
  '#fb923c', '#2dd4bf', '#f472b6', '#a3e635', '#818cf8',
  '#f87171', '#60a5fa', '#facc15', '#34d399', '#e879f9',
];
