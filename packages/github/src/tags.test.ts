import { describe, expect, it, vi } from "vitest";
import { createOctokit } from "./client.js";
import { GitHubRateLimitError, GitHubRepositoryNotFoundError } from "./poller.js";
import { buildTagChangelog, compareCommits, fetchRecentTags, mapTag, TAG_CHANGELOG_MAX_COMMITS, type GitTag } from "./tags.js";

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...init.headers },
  });
}

function mockFetch(handler: (url: URL, init: RequestInit) => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init ?? {});
  });
}

const commit = (oid: string, date: string, message = `commit ${oid}`) => ({
  __typename: "Commit",
  oid,
  url: `https://github.com/acme/widget/commit/${oid}`,
  message,
  committedDate: date,
});

describe("fetchRecentTags", () => {
  it("queries refs/tags by commit date and maps lightweight and annotated tags", async () => {
    const fetch = mockFetch((url, init) => {
      expect(url.pathname).toBe("/graphql");
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toContain('refPrefix: "refs/tags/"');
      expect(body.query).toContain("TAG_COMMIT_DATE");
      expect(body.variables).toEqual({ owner: "acme", name: "widget", first: 20 });
      return json({
        data: {
          repository: {
            refs: {
              nodes: [
                {
                  name: "v2.0.0",
                  target: {
                    __typename: "Tag",
                    message: "Version 2\n\nBig one.\n",
                    tagger: { date: "2026-10-30T10:00:00Z" },
                    target: commit("bbbbbbbbbb", "2026-10-29T09:00:00Z"),
                  },
                },
                { name: "v1.9.0", target: commit("aaaaaaaaaa", "2026-10-01T00:00:00Z") },
                { name: "tree-tag", target: { __typename: "Tree" } },
              ],
            },
          },
        },
      });
    });

    const tags = await fetchRecentTags({ owner: "acme", name: "widget", accessToken: "t", octokit: createOctokit({ fetch }) });

    expect(tags).toEqual([
      {
        name: "v2.0.0",
        sha: "bbbbbbbbbb",
        commitUrl: "https://github.com/acme/widget/commit/bbbbbbbbbb",
        commitMessage: "commit bbbbbbbbbb",
        commitDate: new Date("2026-10-29T09:00:00Z"),
        message: "Version 2\n\nBig one.",
        taggerDate: new Date("2026-10-30T10:00:00Z"),
      },
      {
        name: "v1.9.0",
        sha: "aaaaaaaaaa",
        commitUrl: "https://github.com/acme/widget/commit/aaaaaaaaaa",
        commitMessage: "commit aaaaaaaaaa",
        commitDate: new Date("2026-10-01T00:00:00Z"),
        message: null,
        taggerDate: null,
      },
    ]);
  });

  it("maps a missing repository to GitHubRepositoryNotFoundError", async () => {
    const fetch = mockFetch(() =>
      json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }),
    );
    await expect(
      fetchRecentTags({ owner: "acme", name: "gone", accessToken: "t", octokit: createOctokit({ fetch }) }),
    ).rejects.toBeInstanceOf(GitHubRepositoryNotFoundError);
  });

  it("maps a GraphQL RATE_LIMITED error to GitHubRateLimitError", async () => {
    const fetch = mockFetch(() =>
      json(
        { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1798761600" } },
      ),
    );
    const error = await fetchRecentTags({ owner: "acme", name: "widget", accessToken: "t", octokit: createOctokit({ fetch }) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt).toEqual(new Date(1798761600 * 1000));
  });
});

describe("compareCommits", () => {
  it("requests base...head and returns commits newest first", async () => {
    const fetch = mockFetch((url) => {
      expect(decodeURIComponent(url.pathname)).toBe("/repos/acme/widget/compare/v1.0.0...v1.1.0");
      return json({
        html_url: "https://github.com/acme/widget/compare/v1.0.0...v1.1.0",
        total_commits: 2,
        commits: [
          { sha: "1111111aaa", html_url: "https://github.com/acme/widget/commit/1111111aaa", commit: { message: "Older\n\nbody" }, author: null },
          { sha: "2222222bbb", html_url: "https://github.com/acme/widget/commit/2222222bbb", commit: { message: "Newer" }, author: { login: "octo" } },
        ],
      });
    });

    const result = await compareCommits({ owner: "acme", name: "widget", base: "v1.0.0", head: "v1.1.0", octokit: createOctokit({ fetch }) });

    expect(result).toEqual({
      base: "v1.0.0",
      htmlUrl: "https://github.com/acme/widget/compare/v1.0.0...v1.1.0",
      totalCommits: 2,
      commits: [
        { sha: "2222222bbb", subject: "Newer", htmlUrl: "https://github.com/acme/widget/commit/2222222bbb", authorLogin: "octo" },
        { sha: "1111111aaa", subject: "Older", htmlUrl: "https://github.com/acme/widget/commit/1111111aaa", authorLogin: null },
      ],
    });
  });

  it("maps 404 to GitHubRepositoryNotFoundError", async () => {
    const fetch = mockFetch(() => json({ message: "Not Found" }, { status: 404 }));
    await expect(
      compareCommits({ owner: "acme", name: "widget", base: "a", head: "b", octokit: createOctokit({ fetch }) }),
    ).rejects.toBeInstanceOf(GitHubRepositoryNotFoundError);
  });
});

const TAG: GitTag = {
  name: "v1.1.0",
  sha: "abcdef1234567",
  commitUrl: "https://github.com/acme/widget/commit/abcdef1234567",
  commitMessage: "Bump version\n\ndetails",
  commitDate: new Date("2026-10-02T00:00:00Z"),
  message: null,
  taggerDate: null,
};

describe("buildTagChangelog", () => {
  it("lists commits since the previous tag with the comparison link", () => {
    const body = buildTagChangelog(
      { ...TAG, message: "Release 1.1" },
      {
        base: "v1.0.0",
        htmlUrl: "https://github.com/acme/widget/compare/v1.0.0...v1.1.0",
        totalCommits: 1,
        commits: [{ sha: "2222222bbb", subject: "Add feature", htmlUrl: "https://x/c/2", authorLogin: "octo" }],
      },
    );
    expect(body).toBe(
      [
        "Release 1.1",
        "### Commits since `v1.0.0`",
        "- [`2222222`](https://x/c/2) Add feature — @octo",
        "[Compare `v1.0.0...v1.1.0` on GitHub](https://github.com/acme/widget/compare/v1.0.0...v1.1.0) · 1 commit",
      ].join("\n\n"),
    );
  });

  it("caps the commit list and counts the rest", () => {
    const commits = Array.from({ length: 100 }, (_, i) => ({ sha: `${i}`.padStart(7, "0"), subject: `c${i}`, htmlUrl: "u", authorLogin: null }));
    const body = buildTagChangelog(TAG, { base: "v1.0.0", htmlUrl: "u", totalCommits: 340, commits });
    expect(body.match(/^- \[/gm)).toHaveLength(TAG_CHANGELOG_MAX_COMMITS);
    expect(body).toContain(`- …and ${340 - TAG_CHANGELOG_MAX_COMMITS} more commits`);
  });

  it("falls back to the tagged commit without a previous tag", () => {
    expect(buildTagChangelog(TAG, null)).toBe(
      "### Tagged commit\n\n- [`abcdef1`](https://github.com/acme/widget/commit/abcdef1234567) Bump version",
    );
  });
});

describe("mapTag", () => {
  it("maps to the Release row shape", () => {
    expect(mapTag({ ...TAG, name: "v2.0.0-rc.1" }, "https://github.com/acme/widget/", "body")).toEqual({
      source: "TAG",
      githubReleaseId: null,
      tagSha: "abcdef1234567",
      tagName: "v2.0.0-rc.1",
      title: "v2.0.0-rc.1",
      bodyMarkdown: "body",
      htmlUrl: "https://github.com/acme/widget/releases/tag/v2.0.0-rc.1",
      isPrerelease: true,
      isDraft: false,
      semverType: "PRERELEASE",
      publishedAt: new Date("2026-10-02T00:00:00Z"),
    });
  });

  it("prefers the annotation subject and tagger date", () => {
    const mapped = mapTag(
      { ...TAG, name: "release/2.0", message: "Two point oh\n\nnotes", taggerDate: new Date("2026-10-05T00:00:00Z") },
      "https://github.com/acme/widget",
      "",
    );
    expect(mapped).toMatchObject({
      title: "Two point oh",
      publishedAt: new Date("2026-10-05T00:00:00Z"),
      htmlUrl: "https://github.com/acme/widget/releases/tag/release%2F2.0",
      semverType: "MAJOR",
      isPrerelease: false,
    });
  });
});
