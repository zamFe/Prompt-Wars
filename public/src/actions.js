// The agent's entire control surface.
//
// Deliberately small and slow: an agent cannot strafe, cannot sprint, cannot
// snap its aim onto a target. Everything costs time, so *what* an agent decides
// to do matters far more than how precisely it can do it - which is the point
// of the game.

import { MOVE, WEAPONS, BRAIN } from './config.js';
import { clamp, normalizeDeg, angleDelta, toRad } from './util.js';

/**
 * Movement directions, each an angle offset from the body facing. Sidestepping
 * is the only way to change position without changing where you are looking,
 * which is what makes it worth its lower speed.
 */
export const MOVE_DIRECTIONS = {
  forward: { angle: 0, speed: MOVE.forwardSpeed },
  backward: { angle: 180, speed: MOVE.backwardSpeed },
  left: { angle: -90, speed: MOVE.sidestepSpeed },
  right: { angle: 90, speed: MOVE.sidestepSpeed },
};

export const ACTION_LIMITS = {
  turnDegrees: [5, 180],
  moveSteps: [1, 8],
  aimDegrees: [0, MOVE.aimLimit],
  fireShots: [1, 10],
  holdSeconds: [0.1, 3],
};

/**
 * Tool definitions, in Anthropic Messages API shape. The local brain uses the
 * same names and argument ranges, so a prompt behaves consistently across both.
 */
export const TOOL_SCHEMAS = [
  {
    name: 'turn',
    description:
      'Rotate your body left or right by a number of degrees. Your body turns at ' +
      `${MOVE.turnSpeed} degrees per second, so a large turn takes real time and leaves you blind to your flanks. ` +
      'Turning also carries your vision cone and your aim with it.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['left', 'right'], description: 'Which way to rotate.' },
        degrees: { type: 'number', description: 'How far to rotate, 5 to 180 degrees.' },
      },
      required: ['direction', 'degrees'],
    },
  },
  {
    name: 'move',
    description:
      `Travel a number of steps. One step is ${MOVE.stepDistance} units. ` +
      `"forward" (${MOVE.forwardSpeed} units/sec) and "backward" (${MOVE.backwardSpeed} units/sec) go along your body facing. ` +
      `"left" and "right" sidestep - you move sideways at ${MOVE.sidestepSpeed} units/sec while your body facing, vision cone and aim all stay exactly where they are. ` +
      'Sidestepping is how you dodge, circle a target you are already aiming at, or lean out from cover without losing sight of it. ' +
      'Walking into a wall ends the move early.',
    input_schema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['forward', 'backward', 'left', 'right'],
          description: 'Which way to travel. "left" and "right" sidestep without turning.',
        },
        steps: { type: 'number', description: 'How many steps, 1 to 8.' },
      },
      required: ['direction', 'steps'],
    },
  },
  {
    name: 'aim',
    description:
      `Offset your gun from your body facing, up to ${MOVE.aimLimit} degrees either side, at ${MOVE.aimSpeed} degrees per second. ` +
      'Use "center" to bring the gun back in line with your body. Fine corrections with aim are much faster than turning your whole body.',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['left', 'right', 'center'], description: 'Which way to swing the gun.' },
        degrees: { type: 'number', description: `How far from your body facing to aim, 0 to ${MOVE.aimLimit}. Ignored for "center".` },
      },
      required: ['direction'],
    },
  },
  {
    name: 'fire',
    description:
      'Fire your weapon along your current aim. Shots are spaced by your weapon\'s cycle time. ' +
      'Firing stops early if the magazine runs dry - it never reloads for you.',
    input_schema: {
      type: 'object',
      properties: {
        shots: { type: 'number', description: 'How many shots to attempt, 1 to 10.' },
      },
      required: ['shots'],
    },
  },
  {
    name: 'reload',
    description:
      'Refill your magazine. You cannot fire while reloading, and reloads cannot be cancelled once started. ' +
      'Reload times: pistol 2s, shotgun 3s, assault rifle 2s.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'hold',
    description:
      'Stand still and keep watching your cone for up to 3 seconds. Useful for ambushes, and for letting a reload finish.',
    input_schema: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to hold, 0.1 to 3 seconds.' },
      },
      required: ['seconds'],
    },
  },
];

export const TOOL_NAMES = TOOL_SCHEMAS.map((t) => t.name);

/**
 * Short, human-facing summaries of the same tools, for the panel a prompt
 * writer reads. Kept beside the schemas so a new tool cannot be added without
 * one - there is a test asserting these keys match TOOL_NAMES exactly.
 */
export const TOOL_SUMMARIES = {
  turn: `Rotate the body at ${MOVE.turnSpeed}°/s. Slow, and you are blind to wherever you turned away from.`,
  move:
    `Travel ${MOVE.stepDistance}u per step. Forward ${MOVE.forwardSpeed}u/s, back ${MOVE.backwardSpeed}u/s, ` +
    `sidestep ${MOVE.sidestepSpeed}u/s without turning.`,
  aim: `Swing the gun up to ±${MOVE.aimLimit}° off the body at ${MOVE.aimSpeed}°/s. Much faster than turning.`,
  fire: 'Shoot along the current aim. Stops when the magazine runs dry.',
  reload: 'Refill the magazine. Cannot be cancelled, and nothing reloads for you.',
  hold: 'Stand still and keep watching the cone.',
};

const clampRange = (value, [lo, hi], fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
};

/**
 * Turn a raw tool call from either brain into an action the simulation can run,
 * or null if it is not a usable action. Never throws - a malformed call from a
 * model should cost the agent a turn, not crash the arena.
 */
export function normalizeAction(call, agent) {
  if (!call || typeof call.name !== 'string') return null;
  const input = call.input && typeof call.input === 'object' ? call.input : {};
  const built = buildAction(call, input, agent);
  // The id ties an action back to the tool call that asked for it, so what
  // actually happened can be reported against that call next turn.
  if (built && call.id) built.id = call.id;
  return built;
}

function buildAction(call, input, agent) {
  switch (call.name) {
    case 'turn': {
      const direction = input.direction === 'left' ? 'left' : 'right';
      const degrees = clampRange(input.degrees, ACTION_LIMITS.turnDegrees, 45);
      return { type: 'turn', direction, remaining: degrees, total: degrees };
    }
    case 'move': {
      const direction = MOVE_DIRECTIONS[input.direction] ? input.direction : 'forward';
      const steps = Math.round(clampRange(input.steps, ACTION_LIMITS.moveSteps, 2));
      const distance = steps * MOVE.stepDistance;
      return { type: 'move', direction, remaining: distance, total: distance, steps, travelled: 0 };
    }
    case 'aim': {
      if (input.direction === 'center') return { type: 'aim', target: 0 };
      const sign = input.direction === 'left' ? -1 : 1;
      const degrees = clampRange(input.degrees, ACTION_LIMITS.aimDegrees, 10);
      return { type: 'aim', target: sign * degrees };
    }
    case 'fire': {
      const weapon = WEAPONS[agent?.weapon] ?? WEAPONS.pistol;
      const shots = Math.round(
        clampRange(input.shots, [1, Math.max(1, weapon.magazine)], 1),
      );
      return { type: 'fire', remaining: shots, total: shots, fired: 0 };
    }
    case 'reload':
      return { type: 'reload', started: false };
    case 'hold': {
      const seconds = clampRange(input.seconds, ACTION_LIMITS.holdSeconds, 0.5);
      return { type: 'hold', remaining: seconds, total: seconds };
    }
    default:
      return null;
  }
}

/** Convert a decision (list of tool calls) into a bounded action queue. */
export function buildQueue(calls, agent) {
  if (!Array.isArray(calls)) return [];
  return calls
    .slice(0, BRAIN.maxActionsPerDecision)
    .map((call) => normalizeAction(call, agent))
    .filter(Boolean);
}

/** Short human-readable form of an action, for the UI feed. */
export function describeAction(action) {
  if (!action) return 'idle';
  switch (action.type) {
    case 'turn': return `turn ${action.direction} ${Math.round(action.total)}°`;
    case 'move': return action.direction === 'left' || action.direction === 'right'
      ? `sidestep ${action.direction} ${action.steps}`
      : `move ${action.direction} ${action.steps}`;
    case 'aim': return action.target === 0 ? 'aim center' : `aim ${action.target < 0 ? 'left' : 'right'} ${Math.abs(Math.round(action.target))}°`;
    case 'fire': return `fire x${action.total}`;
    case 'reload': return 'reload';
    case 'hold': return `hold ${action.total}s`;
    default: return action.type;
  }
}

/**
 * What actually became of an action. This is what an agent is told about its
 * own previous moves, so it is written in terms of consequences, not internals.
 */
export function describeOutcome(action, { interrupted = false } = {}) {
  if (!action) return 'nothing happened';
  const stopped = interrupted ? ', then you were interrupted' : '';

  switch (action.type) {
    case 'turn': {
      const done = Math.round(action.total - action.remaining);
      return action.remaining > 1
        ? `turned ${action.direction} ${done}° of ${Math.round(action.total)}° before stopping${stopped}`
        : `turned ${action.direction} ${Math.round(action.total)}°${stopped}`;
    }
    case 'move': {
      const steps = action.travelled / MOVE.stepDistance;
      if (action.blocked) return `blocked by a wall after ${steps.toFixed(1)} of ${action.steps} steps ${action.direction}`;
      return steps + 0.05 >= action.steps
        ? `moved ${action.steps} steps ${action.direction}${stopped}`
        : `moved ${steps.toFixed(1)} of ${action.steps} steps ${action.direction}${stopped}`;
    }
    case 'aim':
      return `aim now ${Math.round(action.target)}° from your body facing${stopped}`;
    case 'fire': {
      if (action.fired === 0) return 'fired nothing - the magazine was empty or the weapon was not ready';
      return action.fired < action.total
        ? `fired ${action.fired} of ${action.total} shots, then ran dry`
        : `fired ${action.fired} shot${action.fired === 1 ? '' : 's'}${stopped}`;
    }
    case 'reload':
      return action.started && !interrupted ? 'reloaded, magazine full' : 'reload started but did not finish';
    case 'hold':
      return `held position${stopped}`;
    default:
      return 'done';
  }
}

/**
 * Advance one action by `dt`. Returns true when the action is finished.
 * Movement and shooting are delegated back to the world through `ctx`, which
 * owns collision and projectiles.
 */
export function stepAction(agent, action, dt, ctx) {
  switch (action.type) {
    case 'turn': {
      const amount = Math.min(MOVE.turnSpeed * dt, action.remaining);
      agent.facing = normalizeDeg(agent.facing + (action.direction === 'left' ? -amount : amount));
      action.remaining -= amount;
      return action.remaining <= 1e-6;
    }

    case 'move': {
      const spec = MOVE_DIRECTIONS[action.direction] ?? MOVE_DIRECTIONS.forward;
      const amount = Math.min(spec.speed * dt, action.remaining);
      // The angle offset carries the direction, so the body never rotates here.
      const rad = toRad(agent.facing + spec.angle);
      const moved = ctx.tryMove(agent, Math.cos(rad) * amount, Math.sin(rad) * amount);
      action.remaining -= amount;
      if (moved) action.travelled += amount;
      // Bumping a wall ends the move so the agent is not stuck grinding into it.
      if (!moved) {
        agent.blocked = true;
        action.blocked = true;
        return true;
      }
      return action.remaining <= 1e-6;
    }

    case 'aim': {
      const delta = angleDelta(agent.aimOffset, action.target);
      const amount = Math.min(MOVE.aimSpeed * dt, Math.abs(delta));
      agent.aimOffset = clamp(
        agent.aimOffset + Math.sign(delta) * amount,
        -MOVE.aimLimit,
        MOVE.aimLimit,
      );
      return Math.abs(angleDelta(agent.aimOffset, action.target)) < 0.5;
    }

    case 'fire': {
      if (agent.reloadUntil > ctx.now) return false;      // wait out a reload
      if (agent.nextShotAt > ctx.now) return false;       // weapon still cycling
      if (agent.ammo <= 0) return true;                   // dry: caller must reload
      ctx.fireWeapon(agent);
      action.fired += 1;
      action.remaining -= 1;
      return action.remaining <= 0;
    }

    case 'reload': {
      const weapon = WEAPONS[agent.weapon] ?? WEAPONS.pistol;
      if (!action.started) {
        action.started = true;
        agent.reloadUntil = ctx.now + weapon.reloadTime;
        ctx.pulse?.(agent, 'reload');
        return false;
      }
      if (ctx.now >= agent.reloadUntil) {
        agent.ammo = weapon.magazine;
        return true;
      }
      return false;
    }

    case 'hold': {
      action.remaining -= dt;
      return action.remaining <= 0;
    }

    default:
      return true;
  }
}
