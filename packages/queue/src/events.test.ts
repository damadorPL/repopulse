import { describe, expect, it } from "vitest";
import { parseRealtimeEvent, serializeRealtimeEvent, userEventsChannel, type RealtimeEvent } from "./events.js";
import { applyBackfillOverrides, BACKFILL_DEFAULTS, readBackfillConfig } from "./backfill.js";
import { notificationJobId, releaseBackfillJobId, repoPollJobId } from "./names.js";
import { depsNotifyJobId, depsScanJobId, depsUpdateJobId } from "./deps.js";

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
    expect(depsScanJobId("p1")).toBe("deps-scan-p1");
    expect(depsUpdateJobId("p1", "major-react")).toBe("deps-update-p1-major-react");
    expect(depsNotifyJobId({ ruleId: "r1", projectId: "p1", kind: "digest", scanId: "s1", updateIds: [] })).toBe(
      "deps-notify-r1-s1",
    );
    expect(
      depsNotifyJobId({ ruleId: "r1", projectId: "p1", kind: "pull_request", prId: "pr1", event: "edited", dedupKey: "a:b" }),
    ).toBe("deps-notify-r1-pr1-a-b");
  });
});

describe("parseRealtimeEvent", () => {
  const events: RealtimeEvent[] = [
    { type: "NEW_RELEASE", repositoryId: "r", repositoryName: "a/b", tagName: "v1.0.0", releaseId: "x" },
    { type: "SYNC_STARTED", repositoryId: "r", repositoryName: "a/b" },
    { type: "SYNC_COMPLETED", repositoryId: "r", repositoryName: "a/b", result: "UPDATED", newReleases: 2 },
    { type: "SYNC_FAILED", repositoryId: "r", repositoryName: "a/b", reason: "RATE_LIMITED", message: "later" },
    { type: "HISTORY_BACKFILLED", repositoryId: "r", repositoryName: "a/b", added: 80 },
    { type: "DEPS_SCAN_COMPLETED", projectId: "p", fullName: "a/b", outdated: 3, majors: 1 },
    { type: "DEPS_SCAN_FAILED", projectId: "p", fullName: "a/b", message: "Install the GitHub App" },
    {
      type: "DEPS_PULL_REQUEST_UPDATED",
      projectId: "p",
      fullName: "a/b",
      groupKey: "all",
      state: "OPEN",
      number: 12,
      htmlUrl: "https://github.com/a/b/pull/12",
    },
    {
      type: "DEPS_PULL_REQUEST_UPDATED",
      projectId: "p",
      fullName: "a/b",
      groupKey: "major-react",
      state: "FAILED",
      number: null,
      htmlUrl: null,
      message: "No write access",
    },
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
    JSON.stringify({ type: "DEPS_SCAN_COMPLETED", projectId: "p", fullName: "a/b", outdated: -1, majors: 0 }),
    JSON.stringify({ type: "DEPS_SCAN_COMPLETED", repositoryId: "r", repositoryName: "a/b", outdated: 1, majors: 0 }),
    JSON.stringify({ type: "DEPS_SCAN_FAILED", projectId: "p", fullName: "a/b" }),
    JSON.stringify({ type: "DEPS_PULL_REQUEST_UPDATED", projectId: "p", fullName: "a/b", groupKey: "all", state: "NOPE", number: 1, htmlUrl: null }),
    JSON.stringify({ type: "DEPS_UNKNOWN", projectId: "p", fullName: "a/b" }),
  ])("rejects %s", (raw) => {
    expect(parseRealtimeEvent(raw)).toBeNull();
  });
});

describe("readBackfillConfig", () => {
  it("uses the documented defaults", () => {
    expect(readBackfillConfig({})).toEqual(BACKFILL_DEFAULTS);
    expect(BACKFILL_DEFAULTS).toEqual({
      defaultTarget: 100,
      maxAgeDays: 365,
      hardCap: 1000,
      minQuota: 500,
      deepStep: 200,
      deepCooldownMinutes: 5,
    });
  });

  it("reads overrides and keeps the default target within the hard cap", () => {
    expect(
      readBackfillConfig({
        RELEASE_BACKFILL_DEFAULT_TARGET: "300",
        RELEASE_BACKFILL_MAX_AGE_DAYS: "0",
        RELEASE_BACKFILL_HARD_CAP: "200",
        RELEASE_BACKFILL_MIN_QUOTA: " 50 ",
      }),
    ).toEqual({ defaultTarget: 200, maxAgeDays: 0, hardCap: 200, minQuota: 50, deepStep: 200, deepCooldownMinutes: 5 });
  });

  it("rejects invalid values", () => {
    expect(() => readBackfillConfig({ RELEASE_BACKFILL_HARD_CAP: "-1" })).toThrow(/RELEASE_BACKFILL_HARD_CAP/);
    expect(() => readBackfillConfig({ RELEASE_BACKFILL_MIN_QUOTA: "lots" })).toThrow(/RELEASE_BACKFILL_MIN_QUOTA/);
  });
});

describe("applyBackfillOverrides", () => {
  it("keeps the base values without overrides", () => {
    expect(applyBackfillOverrides(BACKFILL_DEFAULTS, null)).toEqual(BACKFILL_DEFAULTS);
    expect(applyBackfillOverrides(BACKFILL_DEFAULTS, { hardCap: null, deepStep: undefined })).toEqual(BACKFILL_DEFAULTS);
  });

  it("applies each override and keeps the default target within the hard cap", () => {
    expect(applyBackfillOverrides(BACKFILL_DEFAULTS, { defaultTarget: 500, hardCap: 300, maxAgeDays: 0, deepCooldownMinutes: 0 })).toEqual({
      ...BACKFILL_DEFAULTS,
      defaultTarget: 300,
      hardCap: 300,
      maxAgeDays: 0,
      deepCooldownMinutes: 0,
    });
  });

  it("clamps out-of-range values from hand-edited rows", () => {
    const config = applyBackfillOverrides(BACKFILL_DEFAULTS, { hardCap: 0, deepStep: -5, minQuota: 2.7 });
    expect(config).toMatchObject({ hardCap: 1, defaultTarget: 1, deepStep: 1, minQuota: 2 });
  });
});
