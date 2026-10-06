// What a squad fighter does when its commander tells it something.
//
// An order used to change only a bot's temperament - more aggressive, more
// inclined to camp - and nothing about WHERE it went. Where it went was decided
// by a team-mode default ("no enemy in sight: head for their base") that ran
// before any of that, so "hold position" made a bot more cautious on its way to
// the enemy base, and it circled the base when it got there. An order is now a
// destination, and arriving means stopping and watching.
//
// Lanes are read from your own side of the arena: "left flank" is the lane on
// your left as you look from your base toward theirs. North and south mean the
// top and bottom of the arena whichever side you are on - every agent's heading
// is a compass bearing, so those words mean the same thing to everyone.

import { WORLD } from './config.js';
import { clearance } from './arena.js';

export const ORDER_KINDS = ['follow', 'hold', 'push', 'home', 'left', 'right', 'middle', 'spread'];

/**
 * Most specific first: "fall back to the middle" is about the middle, and
 * "hold the left flank" is about the left flank, not about holding.
 */
const PATTERNS = [
  ['spread', /\b(spread out|split up|fan out|cover (every|all) lanes?)\b/],
  ['left', /\b(left|north)(ern)?\s+(flank|side|wing|lane|route)\b|\b(flank|go|move|head|swing|push|take|hold)\s+(the\s+)?(left|north)\b/],
  ['right', /\b(right|south)(ern)?\s+(flank|side|wing|lane|route)\b|\b(flank|go|move|head|swing|push|take|hold)\s+(the\s+)?(right|south)\b/],
  ['middle', /\b(middle|centre|center|mid(field)?)\b/],
  ['home', /\b(fall back|retreat|pull back|withdraw|back to (base|spawn|home)|go home|return to base|defend (the |our )?base)\b/],
  ['follow', /\b(on me|follow me|with me|regroup|rally|form up|come to me|stick (close|with me)|escort me|cover me)\b/],
  ['hold', /\b(hold( position| here| there| that)?|stay( there| here| put| where you are)?|stop|wait|dig in|stand (still|your ground|fast)|don'?t move|guard)\b/],
  ['push', /\b(push|attack|advance|charge|move up|go forward|rush|assault|hunt|go get|take (their|the enemy) base|engage)\b/],
];

/** The kind of order a line is, or null if it is not one. */
export function parseOrder(text) {
  const line = ` ${String(text ?? '').toLowerCase()} `;
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(line)) return kind;
  }
  return null;
}

/** How a fighter answers, out loud, so its commander knows it was heard. */
export const ORDER_REPLIES = {
  follow: 'on you',
  hold: 'holding here',
  push: 'pushing their base',
  home: 'falling back to base',
  left: 'taking the left flank',
  right: 'taking the right flank',
  middle: 'moving to the middle',
  spread: 'taking my lane',
};

/** Find open floor near a point, so a waypoint is never inside a wall. */
function openNear(x, y) {
  if (clearance(x, y) >= 45) return { x, y };
  for (let r = 30; r <= 360; r += 30) {
    for (let a = 0; a < 16; a++) {
      const px = x + Math.cos((a / 16) * Math.PI * 2) * r;
      const py = y + Math.sin((a / 16) * Math.PI * 2) * r;
      if (clearance(px, py) >= 45) return { x: px, y: py };
    }
  }
  return { x, y };
}

/**
 * Where an order points, in the world, for one fighter. Resolved by whatever
 * can see the arena - the fighter itself never gets coordinates.
 *
 * @param order    { kind, anchor? }
 * @param context  { team, self: {x,y}, commander: {x,y}|null, base(team), lane }
 */
export function orderTarget(order, { team, self, commander, base, lane = 0 }) {
  const S = WORLD.size;
  const mine = base(team);
  const theirs = base(team === 'a' ? 'b' : 'a');
  // "Left" as seen from your own base looking at theirs: on the west side that
  // is north; on the east side it is south.
  const westward = mine.x > S / 2;
  const north = openNear(S / 2, 250);
  const south = openNear(S / 2, S - 250);
  const left = westward ? south : north;
  const right = westward ? north : south;

  switch (order?.kind) {
    case 'follow': return commander ?? mine;
    case 'hold': return order.anchor ?? self;
    case 'push': return theirs;
    case 'home': return mine;
    case 'left': return left;
    case 'right': return right;
    case 'middle': return openNear(S / 2, S / 2);
    // One fighter down each lane, and one straight at them.
    case 'spread': return [left, openNear(S / 2, S / 2), right, theirs][lane % 4];
    default: return null;
  }
}

/** How close counts as there. Following keeps a little distance. */
export const ARRIVED = { follow: 130, default: 70 };
