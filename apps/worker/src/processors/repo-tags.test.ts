import { describe, expect, it, vi } from "vitest";
import { GitHubRateLimitError, type GitTag } from "@repopulse/github";
import { mergeFanOutPlans, type StoredRelease } from "./fan-out";
import { pollRepoTags } from "./repo-tags";

const REPO = { id: "repo1", owner: "acme", name: "widget", fullName: "acme/widget", htmlUrl: "https://github.com/acme/widget" };
const DAY = 24 * 60 * 60 * 1000;
const BASE = new Date("2026-10-01T00:00:00Z").getTime();

/** Tag `v1.<n>.0` committed `n` days after BASE. */
function tag(n: number, extra: Partial<GitTag> = {}): GitTag {
  return {
    name: `v1.${n}.0`,
    sha: `sha${n}`.padEnd(10, "0"),
    commitUrl: `https://github.com/acme/widget/commit/sha${n}`,
    commitMessage: `Release 1.${n}`,
    commitDate: new Date(BASE + n * DAY),
    message: null,
    taggerDate: null,
    ...extra,
  };
}

type Sub = { userId: string; trackMode: "RELEASES" | "TAGS_AND_COMMITS"; includePrereleases?: boolean };

function fakePrisma(options: { storedTagNames?: string[]; subscribers: Sub[] }) {
  const inserted: Array<Record<string, unknown>> = [];
  const states: Array<{ userId: string; releaseId: string; isRead: boolean }> = [];
  const repoUpdates: Array<Record<string, unknown>> = [];
  const prisma = {
    release: {
      findMany: vi.fn(async ({ where }: { where: { tagName: { in: string[] } } }) =>
        where.tagName.in.filter((name) => options.storedTagNames?.includes(name)).map((tagName) => ({ tagName })),
      ),
      createManyAndReturn: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        inserted.push(...data);
        return data.map((row) => ({
          id: `id-${String(row.tagName)}`,
          tagName: row.tagName,
          isPrerelease: row.isPrerelease,
          semverType: row.semverType,
          publishedAt: row.publishedAt,
        }));
      }),
    },
    userSubscription: {
      findMany: vi.fn(async () =>
        options.subscribers.map((s) => ({
          userId: s.userId,
          includePrereleases: s.includePrereleases ?? false,
          trackMode: s.trackMode,
          tags: [],
          user: { notificationRules: [{ id: `rule-${s.userId}`, tagId: null, channel: "DISCORD_WEBHOOK", onlyMajorReleases: false }] },
        })),
      ),
    },
    userReleaseState: {
      createMany: vi.fn(async ({ data }: { data: typeof states }) => {
        states.push(...data);
        return { count: data.length };
      }),
    },
    repository: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        repoUpdates.push(data);
        return {};
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma, inserted, states, repoUpdates };
}

const TOKENS = [
  { userId: "u1", token: "t1" },
  { userId: null, token: undefined },
];

function compareStub() {
  return vi.fn(async ({ base, head }: { base: string; head: string }) => ({
    base,
    htmlUrl: `https://github.com/acme/widget/compare/${base}...${head}`,
    totalCommits: 1,
    commits: [{ sha: "c0ffee12345", subject: `work towards ${head}`, htmlUrl: "https://x/c", authorLogin: "octo" }],
  }));
}

describe("pollRepoTags", () => {
  it("stores unknown tags with commits since the previous tag and fans fresh ones out to tag-mode subscribers only", async () => {
    const db = fakePrisma({
      storedTagNames: ["v1.2.0"],
      subscribers: [
        { userId: "tagger", trackMode: "TAGS_AND_COMMITS" },
        { userId: "releaser", trackMode: "RELEASES" },
      ],
    });
    const fetchTags = vi.fn(async () => [tag(4), tag(3), tag(2), tag(1)]);
    const compare = compareStub();
    const now = new Date("2026-10-31T12:00:00Z");

    // Newest row stored before the poll: day 2.5 → v1.3.0 and v1.4.0 are new, v1.1.0 is history.
    const result = await pollRepoTags(
      { prisma: db.prisma as never, fetchTags, compare, now: () => now },
      REPO,
      TOKENS,
      new Date(BASE + 2.5 * DAY),
    );

    expect(fetchTags).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", name: "widget", accessToken: "t1" }));
    // The stored v1.2.0 is skipped; each other tag is compared with the next older one in the list.
    expect(compare.mock.calls.map(([p]) => `${p.base}...${p.head}`)).toEqual(["v1.3.0...v1.4.0", "v1.2.0...v1.3.0"]);
    expect(db.inserted.map((r) => r.tagName)).toEqual(["v1.4.0", "v1.3.0", "v1.1.0"]);
    expect(db.inserted[0]).toMatchObject({ source: "TAG", githubReleaseId: null, repositoryId: "repo1", semverType: "MINOR" });
    expect(String(db.inserted[0]!.bodyMarkdown)).toContain("### Commits since `v1.3.0`");
    // The oldest tag in the list has no previous tag: its body shows the tagged commit.
    expect(String(db.inserted[2]!.bodyMarkdown)).toContain("### Tagged commit");

    expect(result).toMatchObject({ received: 4, stored: 3, fresh: 2 });
    expect(db.states).toEqual([
      { userId: "tagger", releaseId: "id-v1.4.0", isRead: false },
      { userId: "tagger", releaseId: "id-v1.3.0", isRead: false },
    ]);
    expect(result!.plan.notifications.map((n) => n.userId)).toEqual(["tagger", "tagger"]);
    expect(db.repoUpdates).toEqual([{ lastTagsPolledAt: now }]);
  });

  it("treats every tag as new for a repository with nothing stored (capped per user)", async () => {
    const db = fakePrisma({ subscribers: [{ userId: "tagger", trackMode: "TAGS_AND_COMMITS" }] });
    const tags = Array.from({ length: 20 }, (_, i) => tag(20 - i));
    const result = await pollRepoTags(
      { prisma: db.prisma as never, fetchTags: vi.fn(async () => tags), compare: compareStub() },
      REPO,
      TOKENS,
      null,
    );
    expect(result).toMatchObject({ stored: 20, fresh: 20 });
    expect(db.states).toHaveLength(10);
  });

  it("stores a tag without commits when the comparison fails", async () => {
    const db = fakePrisma({ subscribers: [] });
    const compare = vi.fn(async () => {
      throw new Error("502 Bad Gateway");
    });
    await pollRepoTags({ prisma: db.prisma as never, fetchTags: vi.fn(async () => [tag(2), tag(1)]), compare }, REPO, TOKENS, null);
    expect(String(db.inserted[0]!.bodyMarkdown)).toContain("### Tagged commit");
  });

  it("skips without a token (GraphQL needs one)", async () => {
    const db = fakePrisma({ subscribers: [] });
    const fetchTags = vi.fn();
    expect(await pollRepoTags({ prisma: db.prisma as never, fetchTags }, REPO, [{ userId: null, token: undefined }], null)).toBeNull();
    expect(fetchTags).not.toHaveBeenCalled();
  });

  it("is best effort: a rate limit skips the step instead of throwing", async () => {
    const db = fakePrisma({ subscribers: [] });
    const fetchTags = vi.fn(async () => {
      throw new GitHubRateLimitError(null);
    });
    await expect(pollRepoTags({ prisma: db.prisma as never, fetchTags }, REPO, TOKENS, null)).resolves.toBeNull();
    expect(db.repoUpdates).toEqual([]);
  });

  it("falls back past a rejected (401) token", async () => {
    const db = fakePrisma({ subscribers: [] });
    const fetchTags = vi.fn(async ({ accessToken }: { accessToken: string }) => {
      if (accessToken === "t1") throw Object.assign(new Error("Bad credentials"), { status: 401 });
      return [];
    });
    await pollRepoTags({ prisma: db.prisma as never, fetchTags: fetchTags as never }, REPO, [{ userId: "u1", token: "t1" }, { userId: "u2", token: "t2" }], null);
    expect(fetchTags.mock.calls.map(([p]) => p.accessToken)).toEqual(["t1", "t2"]);
  });
});

describe("mergeFanOutPlans", () => {
  const release = (id: string, day: number): StoredRelease => ({
    id,
    tagName: id,
    isPrerelease: false,
    semverType: "PATCH",
    publishedAt: new Date(BASE + day * DAY),
  });

  it("merges deliveries per user, newest first", () => {
    const merged = mergeFanOutPlans(
      { states: [{ userId: "u1", releaseId: "a" }], deliveries: [{ userId: "u1", releases: [release("a", 1)] }], notifications: [] },
      {
        states: [{ userId: "u1", releaseId: "b" }],
        deliveries: [
          { userId: "u1", releases: [release("b", 2)] },
          { userId: "u2", releases: [release("b", 2)] },
        ],
        notifications: [{ ruleId: "r", releaseId: "b", userId: "u2" }],
      },
    );
    expect(merged.states).toHaveLength(2);
    expect(merged.deliveries.map((d) => [d.userId, d.releases.map((r) => r.id)])).toEqual([
      ["u1", ["b", "a"]],
      ["u2", ["b"]],
    ]);
    expect(merged.notifications).toHaveLength(1);
  });
});
