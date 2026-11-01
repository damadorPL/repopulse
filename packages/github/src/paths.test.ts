import { describe, expect, it, vi } from "vitest";
import { createOctokit } from "./client.js";
import {
  buildCommitChangelog,
  COMMIT_CHANGELOG_MAX_FILES,
  commitMatchesAnyPath,
  commitMatchesPath,
  fetchCommitDetail,
  fetchCommitsForPath,
  mapPathCommit,
  MAX_WATCHED_PATH_LENGTH,
  normalizeWatchedPath,
  parseWatchedPaths,
  type CommitDetail,
  type PathCommitSummary,
} from "./paths.js";
import { GitHubRateLimitError, GitHubRepositoryNotFoundError } from "./poller.js";

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...init.headers },
  });
}

function mockFetch(handler: (url: URL) => Response) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url);
  });
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

function summary(extra: Partial<PathCommitSummary> = {}): PathCommitSummary {
  return {
    sha: SHA,
    htmlUrl: `https://github.com/acme/widget/commit/${SHA}`,
    message: "feat(db): add index\n\nSpeeds up the feed query.\r\nCloses #12.",
    committedDate: new Date("2026-10-30T10:00:00Z"),
    authorName: "Octo Cat",
    authorLogin: "octocat",
    ...extra,
  };
}

describe("normalizeWatchedPath", () => {
  it.each([
    ["CHANGELOG.md", "CHANGELOG.md"],
    ["  packages/cli/  ", "packages/cli"],
    ["/packages//db///", "packages/db"],
    ["./docs/README.md", "docs/README.md"],
    ["././src", "src"],
    ["plugins/foo bar", "plugins/foo bar"],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeWatchedPath(raw)).toBe(expected);
  });

  it.each(["", "   ", "/", ".", "..", "./", "a/../b", "../etc", "a/./b", "a\\b", "a?b", "a#b", "a\u0000b", "a\tb"])(
    "rejects %j",
    (raw) => {
      expect(normalizeWatchedPath(raw)).toBeNull();
    },
  );

  it("rejects paths longer than the limit", () => {
    expect(normalizeWatchedPath("a".repeat(MAX_WATCHED_PATH_LENGTH))).toHaveLength(MAX_WATCHED_PATH_LENGTH);
    expect(normalizeWatchedPath("a".repeat(MAX_WATCHED_PATH_LENGTH + 1))).toBeNull();
  });
});

describe("parseWatchedPaths", () => {
  it("splits on newlines and commas, normalizes, dedupes in order and reports invalid entries", () => {
    expect(parseWatchedPaths("CHANGELOG.md, packages/cli\n/packages/cli/\n\n ../x ,docs")).toEqual({
      paths: ["CHANGELOG.md", "packages/cli", "docs"],
      invalid: ["../x"],
      tooMany: false,
    });
  });

  it("accepts a list", () => {
    expect(parseWatchedPaths(["a", "b, c", "a/"]).paths).toEqual(["a", "b", "c"]);
  });

  it("keeps at most 10 paths", () => {
    const result = parseWatchedPaths(Array.from({ length: 12 }, (_, i) => `p${i}`));
    expect(result.paths).toHaveLength(10);
    expect(result.tooMany).toBe(true);
  });
});

describe("commitMatchesPath", () => {
  it("matches the file itself and anything inside a folder, not sibling prefixes", () => {
    expect(commitMatchesPath("packages/db", "packages/db")).toBe(true);
    expect(commitMatchesPath("packages/db/prisma/schema.prisma", "packages/db")).toBe(true);
    expect(commitMatchesPath("packages/dbx/index.ts", "packages/db")).toBe(false);
    expect(commitMatchesPath("packages", "packages/db")).toBe(false);
  });

  it("commitMatchesAnyPath checks every pair", () => {
    expect(commitMatchesAnyPath(["README.md", "src/a.ts"], ["docs", "src"])).toBe(true);
    expect(commitMatchesAnyPath(["README.md"], ["docs", "src"])).toBe(false);
    expect(commitMatchesAnyPath([], ["src"])).toBe(false);
  });
});

describe("fetchCommitsForPath", () => {
  it("lists the newest commits touching the path", async () => {
    const fetch = mockFetch((url) => {
      expect(url.pathname).toBe("/repos/acme/widget/commits");
      expect(url.searchParams.get("path")).toBe("packages/db");
      expect(url.searchParams.get("per_page")).toBe("10");
      return json([
        {
          sha: SHA,
          html_url: "https://github.com/acme/widget/commit/x",
          commit: {
            message: "fix: things",
            author: { name: "Octo", date: "2026-10-01T00:00:00Z" },
            committer: { name: "GitHub", date: "2026-10-02T00:00:00Z" },
          },
          author: { login: "octocat" },
        },
        {
          sha: "b".repeat(40),
          html_url: "https://github.com/acme/widget/commit/y",
          commit: { message: "chore", author: { name: "Someone", date: "2026-09-01T00:00:00Z" }, committer: null },
          author: null,
        },
      ]);
    });
    const commits = await fetchCommitsForPath({ owner: "acme", name: "widget", path: "packages/db", octokit: createOctokit({ fetch }) });
    expect(commits).toEqual([
      {
        sha: SHA,
        htmlUrl: "https://github.com/acme/widget/commit/x",
        message: "fix: things",
        committedDate: new Date("2026-10-02T00:00:00Z"),
        authorName: "Octo",
        authorLogin: "octocat",
      },
      {
        sha: "b".repeat(40),
        htmlUrl: "https://github.com/acme/widget/commit/y",
        message: "chore",
        committedDate: new Date("2026-09-01T00:00:00Z"),
        authorName: "Someone",
        authorLogin: null,
      },
    ]);
  });

  it("returns nothing for an empty repository (409)", async () => {
    const fetch = mockFetch(() => json({ message: "Git Repository is empty." }, { status: 409 }));
    await expect(fetchCommitsForPath({ owner: "a", name: "b", path: "x", octokit: createOctokit({ fetch }) })).resolves.toEqual([]);
  });

  it("maps 404 and rate limits to typed errors", async () => {
    const notFound = mockFetch(() => json({ message: "Not Found" }, { status: 404 }));
    await expect(fetchCommitsForPath({ owner: "a", name: "b", path: "x", octokit: createOctokit({ fetch: notFound }) })).rejects.toBeInstanceOf(
      GitHubRepositoryNotFoundError,
    );
    const limited = mockFetch(() =>
      json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" } }),
    );
    const error = await fetchCommitsForPath({ owner: "a", name: "b", path: "x", octokit: createOctokit({ fetch: limited }) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt).toEqual(new Date(1_900_000_000 * 1000));
    const tooMany = mockFetch(() => json({ message: "slow down" }, { status: 429 }));
    await expect(fetchCommitsForPath({ owner: "a", name: "b", path: "x", octokit: createOctokit({ fetch: tooMany }) })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });
});

describe("fetchCommitDetail", () => {
  it("returns stats and files, and flags a truncated file list", async () => {
    const fetch = mockFetch((url) => {
      expect(url.pathname).toBe(`/repos/acme/widget/commits/${SHA}`);
      return json(
        {
          sha: SHA,
          stats: { additions: 12, deletions: 3, total: 15 },
          files: [
            { filename: "src/a.ts", status: "modified", additions: 10, deletions: 3 },
            { filename: "src/b.ts", status: "renamed", additions: 2, deletions: 0, previous_filename: "src/old.ts" },
          ],
        },
        { headers: { link: `<https://api.github.com/repositories/1/commits/${SHA}?page=2>; rel="next"` } },
      );
    });
    expect(await fetchCommitDetail({ owner: "acme", name: "widget", ref: SHA, octokit: createOctokit({ fetch }) })).toEqual({
      sha: SHA,
      stats: { additions: 12, deletions: 3, total: 15 },
      files: [
        { filename: "src/a.ts", status: "modified", additions: 10, deletions: 3 },
        { filename: "src/b.ts", status: "renamed", additions: 2, deletions: 0, previousFilename: "src/old.ts" },
      ],
      filesTruncated: true,
    });
  });
});

describe("buildCommitChangelog", () => {
  const detail: CommitDetail = {
    sha: SHA,
    stats: { additions: 15, deletions: 4, total: 19 },
    files: [
      { filename: "README.md", status: "modified", additions: 1, deletions: 1 },
      { filename: "packages/db/schema.prisma", status: "modified", additions: 12, deletions: 3 },
      { filename: "packages/db/new.sql", status: "added", additions: 2, deletions: 0 },
      { filename: "packages/db/gone.ts", status: "removed", additions: 0, deletions: 0 },
      { filename: "packages/db/b.ts", status: "renamed", additions: 0, deletions: 0, previousFilename: "packages/db/a.ts" },
    ],
  };

  it("has the body, the author, the files (watched ones first) and the commit link", () => {
    expect(buildCommitChangelog(summary(), detail, ["packages/db"])).toBe(
      [
        "Speeds up the feed query.\nCloses #12.",
        "Committed by **@octocat**",
        "### Changed files",
        [
          "- `packages/db/schema.prisma` (+12 / -3)",
          "- `packages/db/new.sql` (+2 / -0, added)",
          "- `packages/db/gone.ts` (+0 / -0, removed)",
          "- `packages/db/b.ts` (+0 / -0, renamed from `packages/db/a.ts`)",
          "- `README.md` (+1 / -1)",
        ].join("\n"),
        `[View commit \`0123456\` on GitHub](https://github.com/acme/widget/commit/${SHA}) · 5 files changed (+15 / -4)`,
      ].join("\n\n"),
    );
  });

  it("falls back to the author name and skips an empty body", () => {
    const body = buildCommitChangelog(summary({ message: "subject only", authorLogin: null }), detail, []);
    expect(body.startsWith("Committed by **Octo Cat**\n\n### Changed files")).toBe(true);
  });

  it("caps the file list", () => {
    const many: CommitDetail = {
      ...detail,
      files: Array.from({ length: COMMIT_CHANGELOG_MAX_FILES + 3 }, (_, i) => ({ filename: `f${i}`, status: "modified", additions: 1, deletions: 0 })),
    };
    const body = buildCommitChangelog(summary(), many, []);
    expect(body).toContain("- …and 3 more files");
    expect(body).toContain("53 files changed");
    expect(body.match(/^- `f/gm)).toHaveLength(COMMIT_CHANGELOG_MAX_FILES);
  });

  it("lists the watched paths when the detail request failed", () => {
    const body = buildCommitChangelog(summary({ authorLogin: null, authorName: null }), null, ["packages/db", "CHANGELOG.md"]);
    expect(body).toBe(
      [
        "Speeds up the feed query.\nCloses #12.",
        "### Watched paths",
        "- `packages/db`\n- `CHANGELOG.md`",
        `[View commit \`0123456\` on GitHub](https://github.com/acme/widget/commit/${SHA})`,
      ].join("\n\n"),
    );
  });

  it("escapes backticks in file names", () => {
    const body = buildCommitChangelog(
      summary(),
      { ...detail, files: [{ filename: "weird`name", status: "modified", additions: 0, deletions: 0 }] },
      [],
    );
    expect(body).toContain("- `` weird`name `` (+0 / -0)");
  });
});

describe("mapPathCommit", () => {
  it("maps to a COMMIT row keyed by the short SHA", () => {
    const row = mapPathCommit(
      summary(),
      {
        sha: SHA,
        stats: { additions: 1, deletions: 0, total: 1 },
        files: [
          { filename: "packages/db/x.ts", status: "modified", additions: 1, deletions: 0 },
          { filename: "packages/db/new.ts", status: "renamed", additions: 0, deletions: 0, previousFilename: "lib/old.ts" },
        ],
      },
      ["packages/db"],
    );
    expect(row).toMatchObject({
      source: "COMMIT",
      githubReleaseId: null,
      tagSha: SHA,
      tagName: "0123456",
      title: "feat(db): add index",
      htmlUrl: `https://github.com/acme/widget/commit/${SHA}`,
      isPrerelease: false,
      isDraft: false,
      semverType: "OTHER",
      publishedAt: new Date("2026-10-30T10:00:00Z"),
      changedPaths: ["packages/db/x.ts", "packages/db/new.ts", "lib/old.ts", "packages/db"],
    });
  });

  it("uses the short SHA as title for an empty message and keeps the matched paths without detail", () => {
    const row = mapPathCommit(summary({ message: "" }), null, ["docs"]);
    expect(row.title).toBe("0123456");
    expect(row.changedPaths).toEqual(["docs"]);
  });
});
