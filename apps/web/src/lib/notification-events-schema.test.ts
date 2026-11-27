import { describe, expect, it } from "vitest";
import { notificationEventsSchema } from "./notification-events-schema";

describe("notificationEventsSchema", () => {
  it("needs at least one known event and returns them de-duplicated in a fixed order", () => {
    expect(notificationEventsSchema.safeParse([]).success).toBe(false);
    expect(notificationEventsSchema.safeParse(["NOPE"]).success).toBe(false);
    expect(notificationEventsSchema.safeParse("RELEASES").success).toBe(false);
    expect(notificationEventsSchema.parse(["DEPENDENCY_PULL_REQUESTS", "RELEASES"])).toEqual([
      "RELEASES",
      "DEPENDENCY_PULL_REQUESTS",
    ]);
    expect(notificationEventsSchema.parse(["RELEASES", "RELEASES"])).toEqual(["RELEASES"]);
  });
});
