import { describe, expect, it } from "vitest";

import { createUrlSearchSyncState, reconcileUrlSearchQuery } from "./url-search";

describe("url-search sync", () => {
  it("ignores in-flight self-pushed updates while the user keeps typing", () => {
    const state = { ...createUrlSearchSyncState(""), pendingPushes: ["a", "ab"] };

    // First navigation resolves while user has already typed further.
    expect(reconcileUrlSearchQuery(state, "a")).toBe(false);
    // Second navigation resolves.
    expect(reconcileUrlSearchQuery(state, "ab")).toBe(false);
    expect(state.pendingPushes).toEqual([]);
  });

  it("handles skipped intermediate navigations", () => {
    const state = { ...createUrlSearchSyncState(""), pendingPushes: ["a", "ab"] };

    expect(reconcileUrlSearchQuery(state, "ab")).toBe(false);
    expect(state.pendingPushes).toEqual([]);
  });

  it("syncs external URL changes such as back button or clear links", () => {
    const state = { ...createUrlSearchSyncState(""), pendingPushes: ["react"] };

    expect(reconcileUrlSearchQuery(state, "react")).toBe(false);

    // User clicks "Clear search" link or navigates back.
    expect(reconcileUrlSearchQuery(state, "")).toBe(true);
    expect(state.lastUrlQuery).toBe("");
    expect(state.pendingPushes).toEqual([]);
  });

  it("syncs when navigating back to a previously visited query after it was consumed", () => {
    const state = { ...createUrlSearchSyncState(""), pendingPushes: ["a", "ab"] };

    expect(reconcileUrlSearchQuery(state, "a")).toBe(false);
    expect(reconcileUrlSearchQuery(state, "ab")).toBe(false);

    // Browser back returns to "a", which is no longer pending.
    expect(reconcileUrlSearchQuery(state, "a")).toBe(true);
  });
});
