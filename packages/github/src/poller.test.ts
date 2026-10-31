import { describe, expect, it, vi } from "vitest";
import { createOctokit, GITHUB_USER_AGENT } from "./client.js";
import {
  GitHubRateLimitError,
  GitHubRepositoryNotFoundError,
  pollRepoReleases,
  validateAndFetchRepo,
} from "./poller.js";

const ETAG = 'W/"abc123"';

function release(id: number, tag: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tag_name: tag,
    name: `Release ${tag}`,
    body: `Notes for ${tag}`,
    html_url: `https://github.com/acme/widget/releases/tag/${tag}`,
    prerelease: false,
    draft: false,
    created_at: "2026-10-01T00:00:00Z",
    published_at: "2026-10-02T00:00:00Z",
    ...extra,
  };
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...init.headers },
  });
}

/** Creates a mocked fetch that routes by URL path and records requests. */
function mockFetch(handler: (url: URL, init: RequestInit) => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init ?? {});
  });
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers as Record<string, string> | undefined;
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers![key] : undefined;
}

describe("validateAndFetchRepo", () => {
  it("returns repository metadata, published releases and the exact ETag", async () => {
    const fetch = mockFetch((url) => {
      if (url.pathname === "/repos/acme/widget") {
        return json({
          id: 42,
          name: "widget",
          full_name: "acme/widget",
          description: "A widget",
          html_url: "https://github.com/acme/widget",
          stargazers_count: 1234,
          owner: { login: "acme", avatar_url: "https://avatars.example/acme" },
        });
      }
      if (url.pathname === "/repos/acme/widget/releases") {
        expect(url.searchParams.get("per_page")).toBe("20");
        return json(
          [
            release(3, "v2.0.0-rc.1", { prerelease: true }),
            release(99, "v2.0.0", { draft: true, published_at: null }),
            release(2, "v1.1.0", { name: null }),
            release(1, "v1.0.1"),
          ],
          { headers: { etag: ETAG } },
        );
      }
      return json({ message: "Not Found" }, { status: 404 });
    });

    const result = await validateAndFetchRepo("acme", "widget", undefined, {
      octokit: createOctokit({ fetch }),
    });

    expect(result.repository).toEqual({
      githubRepoId: 42,
      owner: "acme",
      name: "widget",
      fullName: "acme/widget",
      description: "A widget",
      avatarUrl: "https://avatars.example/acme",
      htmlUrl: "https://github.com/acme/widget",
      starsCount: 1234,
    });
    expect(result.etag).toBe(ETAG);
    expect(result.rateLimitRemaining).toBe(4999);
    expect(result.releases.map((r) => [r.githubReleaseId, r.semverType])).toEqual([
      [3n, "PRERELEASE"],
      [2n, "MINOR"],
      [1n, "PATCH"],
    ]);
    expect(result.releases[1]).toMatchObject({ title: "v1.1.0", isDraft: false, isPrerelease: false });
    expect(result.releases[0]!.publishedAt).toEqual(new Date("2026-10-02T00:00:00Z"));

    const [, init] = fetch.mock.calls[0]!;
    expect(headerOf(init!, "user-agent")).toContain(GITHUB_USER_AGENT);
  });

  it("throws GitHubRepositoryNotFoundError on 404", async () => {
    const fetch = mockFetch(() => json({ message: "Not Found" }, { status: 404 }));
    await expect(
      validateAndFetchRepo("acme", "missing", undefined, { octokit: createOctokit({ fetch }) }),
    ).rejects.toBeInstanceOf(GitHubRepositoryNotFoundError);
  });

  it("throws GitHubRateLimitError when the quota is exhausted", async () => {
    const fetch = mockFetch(() =>
      json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1798761600" } },
      ),
    );
    const error = await validateAndFetchRepo("acme", "widget", undefined, {
      octokit: createOctokit({ fetch }),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt).toEqual(new Date(1798761600 * 1000));
  });
});

describe("pollRepoReleases", () => {
  it("sends If-None-Match and returns NOT_MODIFIED on 304", async () => {
    const fetch = mockFetch((_url, init) => {
      expect(headerOf(init, "if-none-match")).toBe(ETAG);
      return new Response(null, { status: 304, headers: { etag: ETAG, "x-ratelimit-remaining": "4990" } });
    });

    const result = await pollRepoReleases({
      owner: "acme",
      name: "widget",
      lastEtag: ETAG,
      octokit: createOctokit({ fetch }),
    });

    expect(result).toEqual({ status: "NOT_MODIFIED", etag: ETAG, releases: [], rateLimitRemaining: 4990 });
  });

  it("returns UPDATED with mapped releases and the new ETag on 200", async () => {
    const fetch = mockFetch((url, init) => {
      expect(url.searchParams.get("per_page")).toBe("20");
      expect(headerOf(init, "if-none-match")).toBeUndefined();
      return json([release(10, "v3.0.0"), release(11, "v3.1.0", { draft: true })], {
        headers: { etag: '"new-etag"' },
      });
    });

    const result = await pollRepoReleases({ owner: "acme", name: "widget", octokit: createOctokit({ fetch }) });

    expect(result.status).toBe("UPDATED");
    expect(result.etag).toBe('"new-etag"');
    expect(result.rateLimitRemaining).toBe(4999);
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({ githubReleaseId: 10n, tagName: "v3.0.0", semverType: "MAJOR" });
  });
});
