import { createLocalBrain } from './local.js';
import { createClaudeBrain } from './claude.js';
import { BRAIN } from '../config.js';

export function createBrains() {
  const local = createLocalBrain({ thinkTime: BRAIN.localThinkTime });
  const claude = createClaudeBrain({ fallback: local });
  return { local, claude };
}

export { createLocalBrain, createClaudeBrain };
