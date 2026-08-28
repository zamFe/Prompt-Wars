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
      return { type: 'move', direction, remaining: distance, total: distance, steps };
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
      return { type: 'fire', remaining: shots, total: shots };
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
      // Bumping a wall ends the move so the agent is not stuck grinding into it.
      if (!moved) {
        agent.blocked = true;
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
      action.remaining -= 1;
      return action.remaining <= 0;
    }

    case 'reload': {
      const weapon = WEAPONS[agent.weapon] ?? WEAPONS.pistol;
      if (!action.started) {
        action.started = true;
        agent.reloadUntil = ctx.now + weapon.reloadTime;
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
