// Brain backed by a real model.
//
// The browser never holds an API key - it posts the sensor snapshot to this
// game's own /api/decide endpoint, which calls the Messages API server-side and
// returns the tool calls the model made.

import { renderSnapshotText } from '../sensors.js';
import { BRAIN } from '../config.js';

export function createClaudeBrain({ endpoint = '/api/decide', fallback = null } = {}) {
  let available = true;
  let lastFailureAt = 0;

  return {
    id: 'claude',
    label: 'Claude (live model)',

    get available() {
      return available;
    },

    /** Re-check availability a minute after a hard failure. */
    markUnavailable() {
      available = false;
      lastFailureAt = Date.now();
    },

    async decide(snapshot, participant) {
      if (!available && Date.now() - lastFailureAt < 60_000) {
        if (fallback) return fallback.decide(snapshot, participant);
        throw new Error('model backend unavailable');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BRAIN.decisionTimeout * 1000);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: participant.prompt,
            name: participant.name,
            observation: renderSnapshotText(snapshot),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          if (response.status === 503 || response.status === 501) this.markUnavailable();
          throw new Error(`${response.status} ${detail.slice(0, 160)}`);
        }

        available = true;
        const data = await response.json();
        return { actions: data.actions ?? [], note: data.note ?? null, chat: data.chat ?? null };
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('model timed out');
        if (fallback && !available) return fallback.decide(snapshot, participant);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
