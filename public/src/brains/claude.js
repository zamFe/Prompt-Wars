// Brain backed by a real model.
//
// The browser never holds an API key - it posts the sensor snapshot to this
// game's own /api/decide endpoint, which calls the Messages API server-side and
// returns the tool calls the model made.

import { renderSnapshotText } from '../sensors.js';
import { BRAIN } from '../config.js';
import { drainInbox } from '../comms.js';

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

    /** Tell the server a life is over so its conversation can be dropped. */
    endSession(agentId) {
      // No server behind this page: there is no conversation to end.
      if (!agentId || !available || !location.protocol.startsWith('http')) return;
      fetch(`/api/session?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' }).catch(() => {});
    },

    async decide(snapshot, participant, memory) {
      if (!available && Date.now() - lastFailureAt < 60_000) {
        if (fallback) return fallback.decide(snapshot, participant, memory);
        throw new Error('model backend unavailable');
      }

      // Whatever the operator has said since the last decision travels with
      // the snapshot. The server holds the conversation; this is the only
      // place the message can enter it.
      const messages = memory?.messages ?? drainInbox(participant);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BRAIN.decisionTimeout * 1000);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            // The agent id is per life, so each character gets its own context.
            agentId: memory?.agentId,
            prompt: participant.prompt,
            name: participant.name,
            observation: renderSnapshotText(snapshot),
            results: memory?.results ?? [],
            messages,
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
        return {
          actions: data.actions ?? [],
          note: data.note ?? null,
          chat: data.chat ?? null,
          reply: data.reply ?? null,
          turn: data.turn ?? null,
          memory: data.memory ?? null,
        };
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('model timed out');
        // The messages are already out of the inbox: hand them to whoever
        // answers instead, rather than losing them with the failed call.
        if (fallback && !available) return fallback.decide(snapshot, participant, { ...memory, messages });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
