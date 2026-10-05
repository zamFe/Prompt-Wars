// What this page has spent of the viewer's Claude account.
//
// The runtime exposes no account quota - `sample.limits()` reports prompt and
// image caps, nothing about what is left - so this does NOT pretend to read a
// balance. It meters what it can honestly know: the calls this page itself has
// made, against a budget the viewer sets. That doubles as a spend guard, which
// matters when the money is theirs: at the cap, agents fall back to the offline
// brain instead of quietly spending more.

const DEFAULT_BUDGET = 200;

export function createUsageMeter({ budget = DEFAULT_BUDGET, onChange = () => {} } = {}) {
  const state = {
    budget,
    calls: 0,
    errors: 0,
    byTier: { quick: 0, default: 0, complex: 0 },
    lastError: null,
    rateLimitedAt: 0,
    startedAt: Date.now(),
  };

  const notify = () => onChange(snapshot());

  const snapshot = () => ({
    ...state,
    byTier: { ...state.byTier },
    remaining: Math.max(0, state.budget - state.calls),
    fraction: state.budget > 0 ? Math.min(1, state.calls / state.budget) : 0,
    exhausted: state.budget > 0 && state.calls >= state.budget,
    rateLimited: Date.now() - state.rateLimitedAt < 30_000,
  });

  return {
    get state() {
      return snapshot();
    },

    /** One call reached Claude (or tried to). */
    record({ tier = 'quick', error = null } = {}) {
      if (error) {
        state.errors += 1;
        state.lastError = error;
        if (error === 'rate_limited') state.rateLimitedAt = Date.now();
        // A call that never reached Claude cost nothing, so it is not metered.
        if (['not_granted', 'sampling_disabled', 'not_declared', 'invalid_request', 'cancelled'].includes(error)) {
          notify();
          return;
        }
      }
      state.calls += 1;
      if (tier in state.byTier) state.byTier[tier] += 1;
      notify();
    },

    setBudget(value) {
      const next = Number(value);
      if (!Number.isFinite(next) || next < 0) return;
      state.budget = Math.round(next);
      notify();
    },

    reset() {
      state.calls = 0;
      state.errors = 0;
      state.byTier = { quick: 0, default: 0, complex: 0 };
      state.lastError = null;
      state.rateLimitedAt = 0;
      state.startedAt = Date.now();
      notify();
    },
  };
}
