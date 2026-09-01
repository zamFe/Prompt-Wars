// Arena comms: every line an agent says, kept as a running history.
//
// When the server is reachable it owns the log - the client posts lines and
// polls for the authoritative order, so the history survives a page reload and
// is shared between tabs. With no server (the single-file build) the same store
// runs purely in memory with the same cap.

import { CHAT } from './config.js';

export function createChatLog({ endpoint = '/api/chat', max = 1000, pollInterval = 600 } = {}) {
  const local = [];
  let serverBacked = false;
  let lastSeq = 0;
  let localId = 0;
  let syncing = false;
  let onChange = () => {};

  const trim = () => {
    while (local.length > max) local.shift();
  };

  return {
    get messages() {
      return local;
    },
    get serverBacked() {
      return serverBacked;
    },
    get capacity() {
      return max;
    },

    onChange(handler) {
      onChange = handler;
    },

    /** Probe once at startup; a static page simply stays local. */
    async connect() {
      if (!location.protocol.startsWith('http')) return false;
      try {
        const response = await fetch(`${endpoint}?since=0`);
        if (!response.ok) return false;
        const data = await response.json();
        serverBacked = true;
        max = data.capacity ?? max;
        this.merge(data);
        return true;
      } catch {
        return false;
      }
    },

    /** A line an agent just said. */
    record(agent, text) {
      const line = String(text ?? '').trim().slice(0, CHAT.maxLength);
      if (!line) return;

      const message = {
        agentId: agent.participant.id,
        name: agent.name,
        color: agent.color,
        text: line,
      };

      if (!serverBacked) {
        // No server: this store is the record.
        local.push({ ...message, seq: `local-${++localId}`, at: Date.now() });
        trim();
        onChange();
        return;
      }

      // Server-backed: post only, and let the poll bring it back. One writer
      // means no duplicate-merging and no ordering guesswork.
      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      }).catch(() => {
        // A dropped post is a lost line, not a broken game.
      });
    },

    merge(data) {
      if (!Array.isArray(data?.messages) || !data.messages.length) return;
      for (const message of data.messages) {
        if (message.seq > lastSeq) local.push(message);
      }
      lastSeq = Math.max(lastSeq, data.seq ?? lastSeq);
      trim();
      onChange();
    },

    async sync() {
      if (!serverBacked || syncing) return;
      syncing = true;
      try {
        const response = await fetch(`${endpoint}?since=${lastSeq}`);
        if (response.ok) this.merge(await response.json());
      } catch {
        // Transient: the next tick tries again.
      } finally {
        syncing = false;
      }
    },

    /** Poll while the page is visible; there is nothing to see when it is not. */
    startPolling() {
      setInterval(() => {
        if (serverBacked && !document.hidden) this.sync();
      }, pollInterval);
    },

    clear() {
      local.length = 0;
      onChange();
    },
  };
}
