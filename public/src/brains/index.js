import { createLocalBrain } from './local.js';
import { createClaudeBrain } from './claude.js';
import { createSampleBrain, MODEL_TIERS, DEFAULT_TIER } from './sample.js';
import { BRAIN } from '../config.js';

/**
 * A brain for an agent somebody else deployed. The host does not think for it -
 * it asks that agent's owner, whose page pays for the answer. If the owner has
 * gone, the offline interpreter takes over rather than leaving it frozen.
 */
export function createRemoteBrain({ net, fallback }) {
  return {
    id: 'remote',
    label: 'Its owner’s account',
    async decide(snapshot, participant, memory) {
      if (!net?.isHost || !participant.ownerPeer) return fallback.decide(snapshot, participant, memory);
      try {
        const answer = await net.askOwner(
          memory?.agentId ?? participant.id,
          participant.ownerPeer,
          { observation: snapshot, results: memory?.results ?? [], name: participant.name },
          BRAIN.decisionTimeout * 1000,
        );
        return { actions: answer?.actions ?? [], chat: answer?.chat ?? null, note: answer?.note ?? null };
      } catch {
        return fallback.decide(snapshot, participant, memory);
      }
    },
  };
}

export function createBrains({ usage } = {}) {
  const local = createLocalBrain({ thinkTime: BRAIN.localThinkTime });
  const sample = createSampleBrain({ usage, fallback: local });
  const claude = createClaudeBrain({ fallback: local });
  return { local, sample, claude };
}

export { createLocalBrain, createClaudeBrain, createSampleBrain, MODEL_TIERS, DEFAULT_TIER };
