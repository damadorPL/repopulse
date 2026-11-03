import { describe, expect, it } from "vitest";
import { isEventAllowedForScope, notificationEventsSchema, normalizeEvents, validateEventsForScope } from "./notification-events";

describe("notificationEventsSchema", () => {
  it("needs at least one known event and returns them de-duplicated in a fixed order", () => {
    expect(notificationEventsSchema.safeParse([]).success).toBe(false);
    expect(notificationEventsSchema.safeParse(["NOPE"]).success).toBe(false);
    expect(notificationEventsSchema.safeParse("RELEASES").success).toBe(false);
    expect(notificationEventsSchema.parse(["DEPENDENCY_PULL_REQUESTS", "RELEASES"])).toEqual(["RELEASES", "DEPENDENCY_PULL_REQUESTS"]);
    expect(notificationEventsSchema.parse(["RELEASES", "RELEASES"])).toEqual(["RELEASES"]);
  });
});

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
