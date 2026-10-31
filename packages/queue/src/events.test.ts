import { describe, expect, it } from "vitest";
import { parseRealtimeEvent, serializeRealtimeEvent, userEventsChannel, type RealtimeEvent } from "./events.js";
import { BACKFILL_DEFAULTS, readBackfillConfig } from "./backfill.js";
import { notificationJobId, releaseBackfillJobId, repoPollJobId } from "./names.js";

describe("userEventsChannel", () => {
  it("scopes the channel to the user", () => {
    expect(userEventsChannel("u1")).toBe("user:u1:events");
  });
});

describe("job ids", () => {
  it("never contain ':' (rejected by BullMQ for custom ids)", () => {
    expect(repoPollJobId("clx123")).toBe("poll-clx123");
    expect(notificationJobId("r1", "rel1")).toBe("notify-r1-rel1");
    expect(repoPollJobId("a")).not.toContain(":");
    expect(releaseBackfillJobId("clx123")).toBe("backfill-clx123");
  });
});

describe("parseRealtimeEvent", () => {
  const events: RealtimeEvent[] = [
    { type: "NEW_RELEASE", repositoryId: "r", repositoryName: "a/b", tagName: "v1.0.0", releaseId: "x" },
    { type: "SYNC_STARTED", repositoryId: "r", repositoryName: "a/b" },
    { type: "SYNC_COMPLETED", repositoryId: "r", repositoryName: "a/b", result: "UPDATED", newReleases: 2 },
    { type: "SYNC_FAILED", repositoryId: "r", repositoryName: "a/b", reason: "RATE_LIMITED", message: "later" },
    { type: "HISTORY_BACKFILLED", repositoryId: "r", repositoryName: "a/b", added: 80 },
  ];

  it.each(events)("round-trips $type", (event) => {
    expect(parseRealtimeEvent(serializeRealtimeEvent(event))).toEqual(event);
  });

  it.each([
    "not json",
    "null",
    "[]",
    JSON.stringify({ type: "UNKNOWN", repositoryId: "r", repositoryName: "a/b" }),
    JSON.stringify({ type: "NEW_RELEASE", repositoryId: "r", repositoryName: "a/b", tagName: "v1" }),
    JSON.stringify({ type: "SYNC_COMPLETED", repositoryId: "r", repositoryName: "a/b", result: "MAYBE", newReleases: 1 }),
    JSON.stringify({ type: "SYNC_COMPLETED", repositoryId: "r", repositoryName: "a/b", result: "UPDATED", newReleases: "1" }),
    JSON.stringify({ type: "SYNC_FAILED", repositoryId: "r", repositoryName: "a/b", reason: "NOPE", message: "x" }),
    JSON.stringify({ type: "SYNC_STARTED", repositoryId: 1, repositoryName: "a/b" }),
    JSON.stringify({ type: "HISTORY_BACKFILLED", repositoryId: "r", repositoryName: "a/b", added: "80" }),
  ])("rejects %s", (raw) => {
    expect(parseRealtimeEvent(raw)).toBeNull();
  });
});

describe("readBackfillConfig", () => {
  it("uses the documented defaults", () => {
    expect(readBackfillConfig({})).toEqual(BACKFILL_DEFAULTS);
    expect(BACKFILL_DEFAULTS).toEqual({ defaultTarget: 100, maxAgeDays: 365, hardCap: 1000, minQuota: 500 });
  });

  it("reads overrides and keeps the default target within the hard cap", () => {
    expect(
      readBackfillConfig({
        RELEASE_BACKFILL_DEFAULT_TARGET: "300",
        RELEASE_BACKFILL_MAX_AGE_DAYS: "0",
        RELEASE_BACKFILL_HARD_CAP: "200",
        RELEASE_BACKFILL_MIN_QUOTA: " 50 ",
      }),
    ).toEqual({ defaultTarget: 200, maxAgeDays: 0, hardCap: 200, minQuota: 50 });
  });

  it("rejects invalid values", () => {
    expect(() => readBackfillConfig({ RELEASE_BACKFILL_HARD_CAP: "-1" })).toThrow(/RELEASE_BACKFILL_HARD_CAP/);
    expect(() => readBackfillConfig({ RELEASE_BACKFILL_MIN_QUOTA: "lots" })).toThrow(/RELEASE_BACKFILL_MIN_QUOTA/);
  });
});
