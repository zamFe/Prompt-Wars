// Hard rules read out of a player's prompt.
//
// Prompting alone cannot guarantee obedience - a model may simply not comply,
// and the offline interpreter and the stub model do not read prompts at all.
// So explicit prohibitions are parsed once and enforced in the simulation,
// where nothing can talk its way past them. "never fire" means the fire tool
// stops working, whichever brain is driving.

const NEGATION = String.raw`(?:never|do\s+not|don['’]?t|must\s+not|mustn['’]?t|refuse\s+to|avoid|no)`;

/** Words that flip a negation into its opposite: "never stop moving" is not a ban on moving. */
const INVERTERS = /\b(?:stop|stopping|cease|ceasing|quit|hesitate|slow)\b/;

const VERBS = {
  turn: /turn(?:ing)?|rotat(?:e|ing)|pivot(?:ing)?/.source,
  move: /mov(?:e|ing)|walk(?:ing)?|advanc(?:e|ing)|step(?:ping)?|strafe|strafing|sidestep(?:ping)?|run(?:ning)?/.source,
  aim: /aim(?:ing)?/.source,
  fire: /fir(?:e|ing)|shoot(?:ing)?|shot/.source,
  reload: /reload(?:ing)?/.source,
  hold: /hold(?:ing)?|wait(?:ing)?/.source,
};

const DIRECTIONS = {
  left: 'left',
  right: 'right',
  forward: 'forward',
  forwards: 'forward',
  ahead: 'forward',
  backward: 'backward',
  backwards: 'backward',
  back: 'backward',
  center: 'center',
  centre: 'center',
};

const DIRECTION_WORDS = Object.keys(DIRECTIONS).join('|');

export const TOOLS_WITH_DIRECTIONS = ['turn', 'move', 'aim'];

function emptyConstraints() {
  return {
    banned: new Set(),
    // Per tool: `allow` is a whitelist when present, `deny` always wins.
    directions: {
      turn: { allow: null, deny: new Set() },
      move: { allow: null, deny: new Set() },
      aim: { allow: null, deny: new Set() },
    },
    rules: [],          // human-readable, for the UI
  };
}

/**
 * Parse the hard rules out of a prompt. Everything else in a prompt stays
 * advisory - this only picks up statements a player clearly meant as absolute.
 */
export function parseConstraints(text = '') {
  const lower = ` ${String(text).toLowerCase().replace(/\s+/g, ' ')} `;
  const constraints = emptyConstraints();

  for (const [tool, verb] of Object.entries(VERBS)) {
    // "never fire", "do not move backward", "never turn left"
    const banPattern = new RegExp(
      `${NEGATION}\\s+((?:\\w+\\s+){0,2}?)(?:${verb})(?:\\s+(${DIRECTION_WORDS}))?\\b`,
      'g',
    );
    for (const match of lower.matchAll(banPattern)) {
      const filler = match[1] ?? '';
      if (INVERTERS.test(filler)) continue;                 // "never stop moving"
      if (tool === 'hold' && /\bback\b/.test(lower.slice(match.index + match[0].length, match.index + match[0].length + 6))) continue;

      const direction = match[2] ? DIRECTIONS[match[2]] : null;
      if (direction && constraints.directions[tool]) {
        constraints.directions[tool].deny.add(direction);
        constraints.rules.push(`never ${tool} ${direction}`);
      } else {
        constraints.banned.add(tool);
        constraints.rules.push(`never ${tool}`);
      }
    }

    // "only turn right", "only move forward"
    if (!constraints.directions[tool]) continue;
    const onlyPattern = new RegExp(`\\bonly\\s+((?:\\w+\\s+){0,2}?)(?:${verb})\\s+(${DIRECTION_WORDS})\\b`, 'g');
    for (const match of lower.matchAll(onlyPattern)) {
      const direction = DIRECTIONS[match[2]];
      constraints.directions[tool].allow ??= new Set();
      constraints.directions[tool].allow.add(direction);
      constraints.rules.push(`only ${tool} ${direction}`);
    }
  }

  constraints.rules = [...new Set(constraints.rules)];
  return constraints;
}

export const hasConstraints = (c) =>
  Boolean(c) && (c.banned.size > 0 || TOOLS_WITH_DIRECTIONS.some((t) => c.directions[t].allow || c.directions[t].deny.size));

/** Would this action be refused? Returns the reason, or null when it is allowed. */
export function violation(action, constraints) {
  if (!action || !constraints || action.forced) return null;

  if (constraints.banned.has(action.type)) return `your orders forbid ${action.type}`;

  const rule = constraints.directions[action.type];
  if (!rule) return null;

  const direction = action.type === 'aim'
    ? (action.target === 0 ? 'center' : action.target < 0 ? 'left' : 'right')
    : action.direction;
  if (!direction) return null;

  if (rule.deny.has(direction)) return `your orders forbid ${action.type} ${direction}`;
  if (rule.allow && !rule.allow.has(direction)) {
    return `your orders allow ${action.type} only ${[...rule.allow].join(' or ')}`;
  }
  return null;
}

/**
 * Drop every action the prompt forbids. Returns the surviving actions plus the
 * reasons, which are fed back to the agent so a model can see why its calls
 * vanished rather than silently repeating them.
 */
export function enforce(actions, constraints) {
  if (!hasConstraints(constraints)) return { actions, refused: [] };

  const kept = [];
  const refused = [];
  for (const action of actions) {
    const reason = violation(action, constraints);
    if (reason) refused.push(reason);
    else kept.push(action);
  }
  return { actions: kept, refused: [...new Set(refused)] };
}

/** One line summarising the rules, for the system prompt and the UI. */
export function describeConstraints(constraints) {
  return hasConstraints(constraints) ? constraints.rules.join('; ') : '';
}
