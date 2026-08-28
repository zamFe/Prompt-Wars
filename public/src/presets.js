// Starter prompts. They double as a tutorial: each one leans on a different
// part of the sensor feed and the tool set.

export const PRESETS = [
  {
    name: 'Hunter',
    prompt:
      'Be aggressive. Hunt down the nearest enemy and close the distance until you are within about 200 units, ' +
      'then fire in bursts. Keep your aim on the target rather than turning your whole body when the bearing is small. ' +
      'Reload only when your magazine is empty and no enemy is in sight. Never retreat.',
  },
  {
    name: 'Ambusher',
    prompt:
      'Camp. Find a wall with cover to one side, hold position and watch your cone. Stay still and wait for someone ' +
      'to walk into view, then fire single, accurate shots. Conserve ammo. If your HP drops below 50, back away ' +
      'from the threat and reload behind cover before fighting again.',
  },
  {
    name: 'Scavenger',
    prompt:
      'Your priority is loot. Always pick up health packs and grab the shotgun or assault rifle whenever one is in sight. ' +
      'Avoid fights while you still carry the pistol. Once you have a better weapon, fight at long range and keep your distance. ' +
      'Retreat below 40 hp and find a medkit.',
  },
  {
    name: 'Spinner',
    prompt:
      'Spin clockwise constantly to sweep the arena with your vision cone. The moment an enemy appears in your cone, ' +
      'stop turning, aim at their bearing and spray. Then resume spinning. Do not chase anyone.',
  },
  {
    name: 'Circler',
    prompt:
      'Never stop moving. When you can see an enemy, aim at their bearing and then circle them by sidestepping - ' +
      'keep stepping to the same side while that side is clear, so your gun stays on them the whole time and you are ' +
      'always a moving target. Fire whenever your aim is lined up. If your wall proximity says that side is closing in, ' +
      'circle the other way instead. Reload only when nothing is in sight.',
  },
  {
    name: 'Wall Crawler',
    prompt:
      'Use your wall proximity readings to keep a wall on your left at all times, and walk the perimeter of the arena. ' +
      'This makes you hard to flank. Fire at anything that enters your cone, at any range. Grab health packs you walk past. ' +
      'Retreat below 30 hp.',
  },
  {
    name: 'Duelist',
    prompt:
      'Fight at long range. Keep roughly 450 units between you and your target, backing up when they close in and ' +
      'advancing when they run. Fire precise single shots, and sidestep between shots so you are never where their last ' +
      'shot was aimed. Always reload the moment the enemy is out of sight. ' +
      'Below 45 hp, break line of sight by turning away and walking, then heal.',
  },
];

export const DEMO_NAMES = [
  'Vex', 'Nyx', 'Rook', 'Quill', 'Sable', 'Onyx', 'Wren', 'Fable', 'Ash', 'Kite',
  'Juno', 'Pike', 'Lyra', 'Corvus', 'Tessel',
];
