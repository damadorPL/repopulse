const DEPS_ENABLED_CACHE_TTL_MS = 15_000;

interface CacheState {
  expiresAt: number;
  value: boolean;
  hasValue: boolean;
  generation: number;
  inflight: Promise<boolean> | null;
}

const state: CacheState = {
  expiresAt: 0,
  value: false,
  hasValue: false,
  generation: 0,
  inflight: null,
};

/** Invalidates the cached `depsEnabled` flag (called after an admin toggle or between tests). */
export function invalidateDepsEnabledCache(): void {
  state.generation += 1;
  state.hasValue = false;
  state.expiresAt = 0;
  state.inflight = null;
}

/**
 * Reads `InstanceSettings.depsEnabled` with a 15 s in-memory TTL + single-flight deduplication
 * so every dashboard layout render does not issue a sequential settings query.
 */
export async function readDepsEnabledCached(load: () => Promise<boolean>): Promise<boolean> {
  const now = Date.now();
  if (state.hasValue && now < state.expiresAt) {
    return state.value;
  }
  if (state.inflight) {
    return state.inflight;
  }
  const gen = state.generation;
  const promise = load().then(
    (enabled) => {
      if (state.generation === gen) {
        state.value = enabled;
        state.hasValue = true;
        state.expiresAt = Date.now() + DEPS_ENABLED_CACHE_TTL_MS;
        state.inflight = null;
      }
      return enabled;
    },
    (error: unknown) => {
      if (state.generation === gen) {
        state.inflight = null;
      }
      throw error;
    },
  );
  state.inflight = promise;
  return promise;
}
