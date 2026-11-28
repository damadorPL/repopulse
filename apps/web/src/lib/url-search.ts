/**
 * Tracks self-initiated URL search updates so in-flight Next.js `router.replace` /
 * `router.push` navigations never clobber characters typed after the navigation
 * started, while external URL changes (back/forward, "Clear search" links) still
 * sync into the input.
 */
export interface UrlSearchSyncState {
  /** Last `urlQuery` observed from the router or server props. */
  lastUrlQuery: string;
  /** Trimmed queries pushed to the router that have not yet arrived via `urlQuery`. */
  pendingPushes: string[];
}

/** Creates the initial URL search sync state for a given starting URL query. */
export function createUrlSearchSyncState(initialUrlQuery: string): UrlSearchSyncState {
  return { lastUrlQuery: initialUrlQuery, pendingPushes: [] };
}

/**
 * Reconciles an incoming `urlQuery` from the router or server props.
 * Returns `true` if the change came from outside (back button, link click) and the
 * local input should reset to `nextUrlQuery`, or `false` if it was our own
 * in-flight navigation resolving.
 */
export function reconcileUrlSearchQuery(state: UrlSearchSyncState, nextUrlQuery: string): boolean {
  if (nextUrlQuery === state.lastUrlQuery) return false;
  state.lastUrlQuery = nextUrlQuery;
  const idx = state.pendingPushes.indexOf(nextUrlQuery);
  if (idx >= 0) {
    // Discard any earlier skipped intermediate pushes as well.
    state.pendingPushes.splice(0, idx + 1);
    return false;
  }
  state.pendingPushes.length = 0;
  return true;
}
