import { describe, expect, it } from "vitest";
import {
  planFanOut,
  rateLimitDelayMs,
  ruleMatches,
  selectFreshReleases,
  type FanOutRule,
  type FanOutSubscriber,
  type StoredRelease,
} from "./fan-out";
import { dueRepositoriesWhere, ERROR_REPOLL_AFTER_MS, REPOLL_AFTER_MS, STALE_POLLING_MS } from "./scheduler.processor";

const day = (n: number) => new Date(Date.UTC(2026, 9, n));

function release(id: string, publishedDay: number, extra: Partial<StoredRelease> = {}): StoredRelease {
  return { id, tagName: `v${id}`, isPrerelease: false, semverType: "MINOR", publishedAt: day(publishedDay), ...extra };
}

function subscriber(userId: string, extra: Partial<FanOutSubscriber> = {}): FanOutSubscriber {
  return { userId, includePrereleases: false, tagIds: [], rules: [], ...extra };
}

function rule(id: string, extra: Partial<FanOutRule> = {}): FanOutRule {
  return { id, tagId: null, channel: "DISCORD_WEBHOOK", onlyMajorReleases: false, ...extra };
}

describe("selectFreshReleases", () => {
  it("keeps only releases newer than the newest stored one, newest first", () => {
    const created = [release("old", 1), release("b", 12), release("a", 15)];
    expect(selectFreshReleases(created, day(10)).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("treats every insert as new when nothing was stored yet", () => {
    expect(selectFreshReleases([release("a", 1), release("b", 2)], null).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("does not count a release published at exactly the newest known instant", () => {
    expect(selectFreshReleases([release("same", 10)], day(10))).toEqual([]);
  });
});

describe("ruleMatches", () => {
  const major = release("m", 1, { semverType: "MAJOR" });
  const minor = release("n", 1);

  it("never queues IN_APP rules (the unread state + SSE is the in-app delivery)", () => {
    expect(ruleMatches(rule("r", { channel: "IN_APP" }), [], major)).toBe(false);
  });

  it("applies untagged rules to every subscription", () => {
    expect(ruleMatches(rule("r"), [], minor)).toBe(true);
  });

  it("requires the rule's tag on the subscription", () => {
    expect(ruleMatches(rule("r", { tagId: "t1" }), ["t2"], minor)).toBe(false);
    expect(ruleMatches(rule("r", { tagId: "t1" }), ["t2", "t1"], minor)).toBe(true);
  });

  it("honors onlyMajorReleases", () => {
    expect(ruleMatches(rule("r", { onlyMajorReleases: true }), [], minor)).toBe(false);
    expect(ruleMatches(rule("r", { onlyMajorReleases: true }), [], major)).toBe(true);
  });

  it("never queues EMAIL_DIGEST rules (no digest sender yet)", () => {
    expect(ruleMatches(rule("r", { channel: "EMAIL_DIGEST" }), [], major)).toBe(false);
  });

  it("Slice 05 acceptance: a Critical + major-only rule fires for v2.0.0 and skips v2.0.1", () => {
    const critical = subscriber("u1", { tagIds: ["critical"], rules: [rule("r1", { tagId: "critical", onlyMajorReleases: true })] });
    const v200 = release("v2.0.0", 5, { tagName: "v2.0.0", semverType: "MAJOR" });
    const v201 = release("v2.0.1", 6, { tagName: "v2.0.1", semverType: "PATCH" });

    expect(planFanOut([critical], [v200]).notifications).toEqual([{ ruleId: "r1", releaseId: "v2.0.0", userId: "u1" }]);
    expect(planFanOut([critical], [v201]).notifications).toEqual([]);
    // Untagged subscriptions never match a tag-scoped rule.
    expect(planFanOut([{ ...critical, tagIds: [] }], [v200]).notifications).toEqual([]);
  });
});

describe("planFanOut", () => {
  const stable = release("s", 3);
  const pre = release("p", 4, { isPrerelease: true, semverType: "PRERELEASE" });

  it("skips pre-releases unless the subscription includes them", () => {
    const plan = planFanOut([subscriber("u1"), subscriber("u2", { includePrereleases: true })], [pre, stable]);
    expect(plan.states).toEqual([
      { userId: "u1", releaseId: "s" },
      { userId: "u2", releaseId: "p" },
      { userId: "u2", releaseId: "s" },
    ]);
    expect(plan.deliveries.map((d) => [d.userId, d.releases.map((r) => r.id)])).toEqual([
      ["u1", ["s"]],
      ["u2", ["p", "s"]],
    ]);
  });

  it("omits subscribers with nothing visible", () => {
    const plan = planFanOut([subscriber("u1")], [pre]);
    expect(plan).toEqual({ states: [], deliveries: [], notifications: [] });
  });

  it("caps per subscriber after the pre-release filter", () => {
    const fresh = [release("p1", 9, { isPrerelease: true }), release("p2", 8, { isPrerelease: true }), release("a", 7), release("b", 6)];
    const plan = planFanOut([subscriber("u1")], fresh, 1);
    expect(plan.states).toEqual([{ userId: "u1", releaseId: "a" }]);
  });

  it("queues one notification per matching rule and visible release", () => {
    const major = release("m", 5, { semverType: "MAJOR" });
    const plan = planFanOut(
      [
        subscriber("u1", {
          tagIds: ["t1"],
          rules: [rule("all"), rule("major", { onlyMajorReleases: true }), rule("other-tag", { tagId: "t9" }), rule("app", { channel: "IN_APP" })],
        }),
      ],
      [major, stable],
    );
    expect(plan.notifications).toEqual([
      { ruleId: "all", releaseId: "m", userId: "u1" },
      { ruleId: "major", releaseId: "m", userId: "u1" },
      { ruleId: "all", releaseId: "s", userId: "u1" },
    ]);
  });
});

describe("rateLimitDelayMs", () => {
  const now = new Date("2026-10-31T12:00:00Z");

  it("waits until the reset plus a second of margin", () => {
    expect(rateLimitDelayMs(new Date("2026-10-31T12:10:00Z"), now)).toBe(10 * 60_000 + 1_000);
  });

  it("falls back to a minute without a reset header", () => {
    expect(rateLimitDelayMs(null, now)).toBe(60_000);
  });

  it("clamps to [5 s, 1 h]", () => {
    expect(rateLimitDelayMs(new Date("2026-10-31T11:00:00Z"), now)).toBe(5_000);
    expect(rateLimitDelayMs(new Date("2026-10-31T15:00:00Z"), now)).toBe(60 * 60_000);
  });
});

describe("dueRepositoriesWhere", () => {
  const now = new Date("2026-10-31T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("requires a subscriber and splits by poll status", () => {
    expect(dueRepositoriesWhere(now)).toEqual({
      subscriptions: { some: {} },
      OR: [
        { pollStatus: "IDLE", OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: ago(REPOLL_AFTER_MS) } }] },
        {
          pollStatus: "POLLING",
          updatedAt: { lt: ago(STALE_POLLING_MS) },
          OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: ago(REPOLL_AFTER_MS) } }],
        },
        { pollStatus: "ERROR", OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: ago(ERROR_REPOLL_AFTER_MS) } }] },
      ],
    });
  });
});
