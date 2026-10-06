// Who is drawn in what colour.
//
// Colour does two different jobs depending on the mode, and the rules follow
// the job:
//
//   free-for-all   colour is identity. Your fighter wears your colour, for
//                  everyone, and bots wear the palette.
//   team modes     colour is the side. Everyone is red or blue - except, on
//                  your own screen only, your own fighter, which wears your
//                  colour so you can always find it.
//   commander      colour is the army. A commander wears its player's colour
//                  and its four wear the same colour a shade off it, so two
//                  armies read as two families.
//
// The team ring drawn around every sphere in a team mode stays regardless, so
// sides are never ambiguous even when two players pick the same favourite.

import { AGENT_COLORS, TEAMS } from './config.js';

export const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('')}`;

function toHsl([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]) {
  if (s === 0) return [l, l, l];
  const hue = (p, q, t) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
}

/** How light a colour reads, 0..1, weighted the way eyes weigh it. */
export function luminance(hex) {
  const [r, g, b] = toRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The same colour, a step away: darker if it is light enough to take it,
 * lighter if it is already dark - so the step is always visible.
 */
export function shade(hex, step = 0.16) {
  if (!isHex(hex)) return hex;
  const [h, s, l] = toHsl(toRgb(hex));
  const darker = luminance(hex) > 0.32;
  return toHex(fromHsl([h, s, Math.min(0.92, Math.max(0.12, l + (darker ? -step : step)))]));
}

/**
 * The colour to draw a fighter in, on THIS page.
 *
 * @param p      a participant, or a result row shaped like one
 * @param view   { mode, mySeat, myColor } - the mode being played, and who is
 *               looking at the screen
 */
export function colorOf(p, { mode = null, mySeat = null, myColor = null } = {}) {
  const palette = AGENT_COLORS[(p?.colorIndex ?? 0) % AGENT_COLORS.length];
  const side = p?.team && TEAMS[p.team] ? TEAMS[p.team].color : null;
  const own = Boolean(p?.seat) && p.seat === mySeat;

  if (mode?.squad) return (isHex(p?.favColor) ? p.favColor : null) ?? side ?? palette;
  if (mode?.teams) return own && isHex(myColor) ? myColor : side ?? palette;
  return (isHex(p?.favColor) ? p.favColor : null) ?? palette;
}
