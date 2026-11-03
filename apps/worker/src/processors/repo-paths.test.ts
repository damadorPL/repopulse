import { describe, expect, it, vi } from "vitest";
import { GitHubRateLimitError, type CommitDetail, type PathCommitSummary } from "@repopulse/github";
import { pollRepoPaths, tracksPaths } from "./repo-paths";

const REPO = { id: "repo1", owner: "acme", name: "widget", fullName: "acme/widget" };
const DAY = 24 * 60 * 60 * 1000;
const BASE = new Date("2026-10-01T00:00:00Z").getTime();
const NOW = new Date("2026-10-31T12:00:00Z");

/** Commit `n` (40-char SHA whose short SHA is `n` zero-padded), committed `n` days after BASE. */
function commit(n: number): PathCommitSummary {
  const sha = String(n).padStart(7, "0").padEnd(40, "a");
  return {
    sha,
    htmlUrl: `https://github.com/acme/widget/commit/${sha}`,
    message: `change ${n}\n\nbody ${n}`,
    committedDate: new Date(BASE + n * DAY),
    authorName: "Octo",
    authorLogin: "octocat",
  };
}
const short = (n: number) => commit(n).sha.slice(0, 7);

type Sub = { userId: string; trackMode: "RELEASES" | "TAGS_AND_COMMITS" | "NONE"; trackPaths?: boolean; watchedPaths?: string[] };
type StoredRow = { id: string; tagName: string; tagSha: string; changedPaths: string[]; publishedAt: Date };

function fakePrisma(options: {
  subscribers: Sub[];
  polledPaths?: string[];
  stored?: StoredRow[];
  existingStates?: Array<{ userId: string; releaseId: string }>;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const states: Array<{ userId: string; releaseId: string; isRead: boolean }> = [];
  const repoUpdates: Array<Record<string, unknown>> = [];
  const releaseUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const toStored = (row: StoredRow) => ({ ...row, isPrerelease: false, semverType: "OTHER" });
  const prisma = {
    repository: {
      findUnique: vi.fn(async () => ({ polledPaths: options.polledPaths ?? [] })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        repoUpdates.push(data);
        return {};
      }),
    },
    release: {
      findMany: vi.fn(async ({ where }: { where: { source: string; OR: [{ tagSha: { in: string[] } }, { tagName: { in: string[] } }] } }) => {
        expect(where.source).toBe("COMMIT");
        const [{ tagSha }, { tagName }] = where.OR;
        return (options.stored ?? []).filter((r) => tagSha.in.includes(r.tagSha) || tagName.in.includes(r.tagName)).map(toStored);
      }),
      createManyAndReturn: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        inserted.push(...data);
        return data.map((row) => ({
          id: `id-${String(row.tagName)}`,
          tagName: row.tagName,
          tagSha: row.tagSha,
          changedPaths: row.changedPaths,
          isPrerelease: false,
          semverType: "OTHER",
          publishedAt: row.publishedAt,
        }));
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        releaseUpdates.push({ id: where.id, data });
        return { id: where.id };
      }),
    },
    userSubscription: {
      findMany: vi.fn(async () =>
        options.subscribers.map((s) => ({
          userId: s.userId,
          includePrereleases: false,
          trackMode: s.trackMode,
          trackPaths: s.trackPaths ?? false,
          watchedPaths: s.watchedPaths ?? [],
          tags: [],
          user: { notificationRules: [{ id: `rule-${s.userId}`, tagId: null, channel: "DISCORD_WEBHOOK", onlyMajorReleases: false, events: ["RELEASES"] }] },
        })),
      ),
    },
    userReleaseState: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] }; releaseId: { in: string[] } } }) =>
        (options.existingStates ?? []).filter((s) => where.userId.in.includes(s.userId) && where.releaseId.in.includes(s.releaseId)),
      ),
      createMany: vi.fn(async ({ data }: { data: typeof states }) => {
        states.push(...data);
        return { count: data.length };
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma, inserted, states, repoUpdates, releaseUpdates };
}

const TOKENS = [
  { userId: "u1", token: "t1" },
  { userId: null, token: undefined },
];

function commitsByPath(map: Record<string, PathCommitSummary[]>) {
  return vi.fn(async ({ path }: { path: string }) => map[path] ?? []);
}

function detailStub(filesBySha: Record<string, string[]> = {}) {
  return vi.fn(
    async ({ ref }: { ref: string }): Promise<CommitDetail> => ({
      sha: ref,
      stats: { additions: 3, deletions: 1, total: 4 },
      files: (filesBySha[ref] ?? []).map((filename) => ({ filename, status: "modified", additions: 3, deletions: 1 })),
    }),
  );
}

const byUser = (states: Array<{ userId: string; releaseId: string; isRead: boolean }>, userId: string) =>
  states.filter((s) => s.userId === userId);

describe("pollRepoPaths", () => {
  it("imports newly watched paths quietly: one row per commit, only each user's own commits, no notification rules", async () => {
    const db = fakePrisma({
      subscribers: [
        { userId: "db-fan", trackMode: "NONE", trackPaths: true, watchedPaths: ["packages/db"] },
        // Releases + tags and "Files / folders" at once.
        { userId: "docs-fan", trackMode: "TAGS_AND_COMMITS", trackPaths: true, watchedPaths: ["docs/", "packages/db"] },
        { userId: "cli-fan", trackMode: "NONE", trackPaths: true, watchedPaths: ["packages/cli"] },
        // Paths kept from earlier, but "Files / folders" is off.
        { userId: "releaser", trackMode: "RELEASES", watchedPaths: ["docs"] },
      ],
    });
    // Commit 3 touches both packages/db and docs.
    const fetchCommits = commitsByPath({ "packages/db": [commit(3), commit(2)], docs: [commit(4), commit(3)], "packages/cli": [] });
    const fetchDetail = detailStub({ [commit(3).sha]: ["packages/db/schema.prisma", "docs/db.md"], [commit(2).sha]: ["packages/db/x.ts"] });

    const result = await pollRepoPaths({ prisma: db.prisma as never, fetchCommits, fetchDetail, now: () => NOW }, REPO, TOKENS);

    // Paths deduplicated across subscribers, in first-seen order; each commit's detail read once.
    expect(fetchCommits.mock.calls.map(([p]) => p.path)).toEqual(["packages/db", "docs", "packages/cli"]);
    expect(fetchCommits).toHaveBeenCalledWith(expect.objectContaining({ owner: "acme", name: "widget", accessToken: "t1" }));
    expect(fetchDetail.mock.calls.map(([p]) => p.ref).sort()).toEqual([commit(2).sha, commit(3).sha, commit(4).sha].sort());
    expect(db.inserted).toHaveLength(3);
    expect(db.inserted.find((r) => r.tagName === short(3))).toMatchObject({
      source: "COMMIT",
      repositoryId: "repo1",
      tagSha: commit(3).sha,
      title: "change 3",
      changedPaths: ["packages/db/schema.prisma", "docs/db.md", "docs", "packages/db"],
    });

    expect(result!.counts).toEqual({ paths: 3, received: 3, stored: 3, fresh: 0, imported: 3 });
    expect(byUser(db.states, "db-fan").map((s) => s.releaseId).sort()).toEqual([`id-${short(2)}`, `id-${short(3)}`]);
    expect(byUser(db.states, "docs-fan").map((s) => s.releaseId).sort()).toEqual([`id-${short(2)}`, `id-${short(3)}`, `id-${short(4)}`]);
    expect(byUser(db.states, "cli-fan")).toEqual([]);
    expect(byUser(db.states, "releaser")).toEqual([]);
    expect(db.states.every((s) => !s.isRead)).toBe(true);
    // Live updates, but existing history never triggers webhook or email rules.
    expect(result!.plan.notifications).toEqual([]);
    expect(result!.plan.deliveries.map((d) => d.userId).sort()).toEqual(["db-fan", "docs-fan"]);
    expect(db.repoUpdates).toEqual([{ lastPathsPolledAt: NOW, polledPaths: ["packages/db", "docs", "packages/cli"] }]);
  });

  it("marks only the 10 newest imported commits unread and the rest read", async () => {
    const db = fakePrisma({ subscribers: [{ userId: "u", trackMode: "NONE", trackPaths: true, watchedPaths: ["src"] }] });
    const commits = Array.from({ length: 12 }, (_, i) => commit(12 - i));
    await pollRepoPaths({ prisma: db.prisma as never, fetchCommits: commitsByPath({ src: commits }), fetchDetail: detailStub() }, REPO, TOKENS);
    expect(db.states.filter((s) => !s.isRead)).toHaveLength(10);
    expect(db.states.filter((s) => s.isRead).map((s) => s.releaseId)).toEqual([`id-${short(2)}`, `id-${short(1)}`]);
  });

  it("fans genuinely new commits of an already polled path out to its watchers, with notification rules", async () => {
    const db = fakePrisma({
      polledPaths: ["packages/db", "docs"],
      subscribers: [
        { userId: "db-fan", trackMode: "NONE", trackPaths: true, watchedPaths: ["packages/db"] },
        { userId: "docs-fan", trackMode: "NONE", trackPaths: true, watchedPaths: ["docs"] },
        { userId: "tagger", trackMode: "TAGS_AND_COMMITS" },
      ],
      stored: [
        { id: "old2", tagName: short(2), tagSha: commit(2).sha, changedPaths: ["packages/db/x.ts", "packages/db"], publishedAt: commit(2).committedDate },
      ],
    });
    // Commit 1 is older than the stored commit 2 but new on the branch (e.g. a merged branch): still new.
    const fetchCommits = commitsByPath({ "packages/db": [commit(5), commit(2), commit(1)], docs: [] });
    const fetchDetail = detailStub();

    const result = await pollRepoPaths({ prisma: db.prisma as never, fetchCommits, fetchDetail }, REPO, TOKENS);

    expect(fetchDetail.mock.calls.map(([p]) => p.ref)).toEqual([commit(5).sha, commit(1).sha]);
    expect(result!.counts).toMatchObject({ received: 3, stored: 2, fresh: 2, imported: 0 });
    expect(db.states).toEqual([
      { userId: "db-fan", releaseId: `id-${short(5)}`, isRead: false },
      { userId: "db-fan", releaseId: `id-${short(1)}`, isRead: false },
    ]);
    expect(result!.plan.notifications).toEqual([
      { ruleId: "rule-db-fan", releaseId: `id-${short(5)}`, userId: "db-fan" },
      { ruleId: "rule-db-fan", releaseId: `id-${short(1)}`, userId: "db-fan" },
    ]);
    expect(db.releaseUpdates).toEqual([]);
  });

  it("mixes both for a user who adds a path: new commits notify, the new path's history is imported quietly", async () => {
    const db = fakePrisma({
      polledPaths: ["packages/db"],
      subscribers: [{ userId: "u", trackMode: "NONE", trackPaths: true, watchedPaths: ["packages/db", "README.md"] }],
      stored: [{ id: "old2", tagName: short(2), tagSha: commit(2).sha, changedPaths: [], publishedAt: commit(2).committedDate }],
      // The user was already seeded with the stored commit 2 when they added the path.
      existingStates: [{ userId: "u", releaseId: "old2" }],
    });
    const fetchCommits = commitsByPath({ "packages/db": [commit(6)], "README.md": [commit(4), commit(2)] });

    const result = await pollRepoPaths({ prisma: db.prisma as never, fetchCommits, fetchDetail: detailStub() }, REPO, TOKENS);

    expect(result!.counts).toMatchObject({ fresh: 1, imported: 2 });
    expect(db.states).toEqual(
      expect.arrayContaining([
        { userId: "u", releaseId: `id-${short(6)}`, isRead: false },
        { userId: "u", releaseId: `id-${short(4)}`, isRead: false },
      ]),
    );
    expect(db.states).toHaveLength(2);
    expect(result!.plan.notifications.map((n) => n.releaseId)).toEqual([`id-${short(6)}`]);
    expect(result!.plan.deliveries).toEqual([{ userId: "u", releases: [expect.objectContaining({ id: `id-${short(6)}` }), expect.objectContaining({ id: `id-${short(4)}` })] }]);
    // The stored commit now also lists the path it was found through.
    expect(db.releaseUpdates).toEqual([{ id: "old2", data: { changedPaths: ["README.md"] } }]);
    expect(db.repoUpdates[0]).toMatchObject({ polledPaths: ["packages/db", "README.md"] });
  });

  it("stores a commit without files when its detail request fails", async () => {
    const db = fakePrisma({ subscribers: [{ userId: "u", trackMode: "NONE", trackPaths: true, watchedPaths: ["docs"] }] });
    const fetchDetail = vi.fn(async () => {
      throw new Error("502 Bad Gateway");
    });
    await pollRepoPaths({ prisma: db.prisma as never, fetchCommits: commitsByPath({ docs: [commit(1)] }), fetchDetail }, REPO, TOKENS);
    expect(db.inserted[0]).toMatchObject({ changedPaths: ["docs"] });
    expect(String(db.inserted[0]!.bodyMarkdown)).toContain("### Watched paths");
  });

  it("is best effort: a rate limit (list or detail) skips the step instead of throwing", async () => {
    const limited = vi.fn(async () => {
      throw new GitHubRateLimitError(null);
    });
    const subscribers: Sub[] = [{ userId: "u", trackMode: "NONE", trackPaths: true, watchedPaths: ["docs"] }];

    const listDb = fakePrisma({ subscribers });
    await expect(pollRepoPaths({ prisma: listDb.prisma as never, fetchCommits: limited }, REPO, TOKENS)).resolves.toBeNull();
    expect(listDb.repoUpdates).toEqual([]);

    const detailDb = fakePrisma({ subscribers });
    await expect(
      pollRepoPaths({ prisma: detailDb.prisma as never, fetchCommits: commitsByPath({ docs: [commit(1)] }), fetchDetail: limited }, REPO, TOKENS),
    ).resolves.toBeNull();
    expect(detailDb.inserted).toEqual([]);
    expect(detailDb.repoUpdates).toEqual([]);
  });

  it("falls back past a rejected (401) token and keeps using the one that worked", async () => {
    const db = fakePrisma({ subscribers: [{ userId: "u", trackMode: "NONE", trackPaths: true, watchedPaths: ["a", "b"] }] });
    const fetchCommits = vi.fn(async ({ accessToken }: { accessToken?: string | null }) => {
      if (accessToken === "t1") throw Object.assign(new Error("Bad credentials"), { status: 401 });
      return [];
    });
    await pollRepoPaths(
      { prisma: db.prisma as never, fetchCommits: fetchCommits as never },
      REPO,
      [{ userId: "u1", token: "t1" }, { userId: "u2", token: "t2" }, { userId: null, token: undefined }],
    );
    expect(fetchCommits.mock.calls.map(([p]) => p.accessToken)).toEqual(["t1", "t2", "t2"]);
  });

  it("does nothing without a subscriber watching paths", async () => {
    const db = fakePrisma({ subscribers: [{ userId: "u", trackMode: "NONE", trackPaths: true, watchedPaths: [] }, { userId: "r", trackMode: "RELEASES", watchedPaths: ["docs"] }] });
    const fetchCommits = vi.fn();
    expect(await pollRepoPaths({ prisma: db.prisma as never, fetchCommits }, REPO, TOKENS)).toBeNull();
    expect(fetchCommits).not.toHaveBeenCalled();
  });
});

describe("tracksPaths", () => {
  const base = { userId: "u", includePrereleases: false, tagIds: [], rules: [] };
  it("needs trackPaths and at least one path, whatever the release mode", () => {
    expect(tracksPaths({ ...base, trackMode: "NONE", trackPaths: true, watchedPaths: ["a"] })).toBe(true);
    expect(tracksPaths({ ...base, trackMode: "RELEASES", trackPaths: true, watchedPaths: ["a"] })).toBe(true);
    expect(tracksPaths({ ...base, trackMode: "NONE", trackPaths: true, watchedPaths: [] })).toBe(false);
    expect(tracksPaths({ ...base, trackMode: "TAGS_AND_COMMITS", trackPaths: false, watchedPaths: ["a"] })).toBe(false);
  });
});
