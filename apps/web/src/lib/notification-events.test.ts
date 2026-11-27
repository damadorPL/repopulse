import { describe, expect, it } from "vitest";

import { isEventAllowedForScope, normalizeEvents, validateEventsForScope } from "./notification-events";

describe("tag scope", () => {
  it("allows only releases for tag-scoped rules", () => {
    expect(isEventAllowedForScope("RELEASES", true)).toBe(true);
    expect(isEventAllowedForScope("DEPENDENCY_UPDATES", true)).toBe(false);
    expect(isEventAllowedForScope("DEPENDENCY_PULL_REQUESTS", false)).toBe(true);
    expect(validateEventsForScope(["RELEASES"], true)).toBeNull();
    expect(validateEventsForScope(["RELEASES", "DEPENDENCY_UPDATES"], true)).toMatch(/only notify about releases/);
    expect(validateEventsForScope(["DEPENDENCY_UPDATES"], false)).toBeNull();
  });

  it("normalizes order", () => {
    expect(normalizeEvents(["DEPENDENCY_UPDATES", "RELEASES"])).toEqual(["RELEASES", "DEPENDENCY_UPDATES"]);
  });
});
