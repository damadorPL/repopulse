import { describe, expect, it } from "vitest";
import { createUrlSearchSyncState, reconcileUrlSearchQuery, recordUrlSearchPush } from "./url-search";

describe("url-search sync", () => {
  it("ignores in-flight self-pushed updates while the user keeps typing", () => {
    const state = createUrlSearchSyncState("");

    expect(recordUrlSearchPush(state, "a")).toBe("a");
    expect(recordUrlSearchPush(state, "ab")).toBe("ab");

    // First navigation resolves while user has already typed further.
    expect(reconcileUrlSearchQuery(state, "a")).toBe(false);
    // Second navigation resolves.
    expect(reconcileUrlSearchQuery(state, "ab")).toBe(false);
    expect(state.pendingPushes).toEqual([]);
  });

  it("handles skipped intermediate navigations", () => {
    const state = createUrlSearchSyncState("");

    recordUrlSearchPush(state, "a");
    recordUrlSearchPush(state, "ab");

    expect(reconcileUrlSearchQuery(state, "ab")).toBe(false);
    expect(state.pendingPushes).toEqual([]);
  });

  it("syncs external URL changes such as back button or clear links", () => {
    const state = createUrlSearchSyncState("");

    recordUrlSearchPush(state, "react");
    expect(reconcileUrlSearchQuery(state, "react")).toBe(false);

    // User clicks "Clear search" link or navigates back.
    expect(reconcileUrlSearchQuery(state, "")).toBe(true);
    expect(state.lastUrlQuery).toBe("");
    expect(state.pendingPushes).toEqual([]);
  });

  it("syncs when navigating back to a previously visited query after it was consumed", () => {
    const state = createUrlSearchSyncState("");

    recordUrlSearchPush(state, "a");
    expect(reconcileUrlSearchQuery(state, "a")).toBe(false);

    recordUrlSearchPush(state, "ab");
    expect(reconcileUrlSearchQuery(state, "ab")).toBe(false);

    // Browser back returns to "a", which is no longer pending.
    expect(reconcileUrlSearchQuery(state, "a")).toBe(true);
  });

  it("does not duplicate identical consecutive pushes or no-op pushes", () => {
    const state = createUrlSearchSyncState("foo");

    recordUrlSearchPush(state, "foo ");
    expect(state.pendingPushes).toEqual([]);

    recordUrlSearchPush(state, "bar");
    recordUrlSearchPush(state, "bar ");
    expect(state.pendingPushes).toEqual(["bar"]);
  });
});
