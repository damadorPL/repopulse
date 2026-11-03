import { describe, expect, it, vi } from "vitest";
import { createOctokit } from "./client.js";
import { fetchGitTree, mapGitTreeEntries } from "./git-tree.js";
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
    return handler(new URL(decodeURIComponent(url.href)));
  });
}

const REPO = {
  id: 42,
  name: "widget",
  full_name: "acme/widget",
  default_branch: "main",
  private: false,
  html_url: "https://github.com/acme/widget",
  owner: { login: "acme" },
};

const TREE = {
  truncated: false,
  tree: [
    { path: "package.json", type: "blob", sha: "b1", size: 120 },
    { path: "apps", type: "tree", sha: "t1" },
    { path: "apps/web/package.json", type: "blob", sha: "b2", size: 80 },
    { path: "vendor/lib", type: "commit", sha: "c1" },
    { path: "odd", type: "tag", sha: "x" },
    { path: "nosha", type: "blob" },
  ],
};

describe("mapGitTreeEntries", () => {
  it("keeps SHAs and blob sizes, sorted by path", () => {
    expect(mapGitTreeEntries(TREE)).toEqual({
      entries: [
        { path: "apps", type: "tree", sha: "t1", size: null },
        { path: "apps/web/package.json", type: "blob", sha: "b2", size: 80 },
        { path: "package.json", type: "blob", sha: "b1", size: 120 },
        { path: "vendor/lib", type: "commit", sha: "c1", size: null },
      ],
      truncated: false,
    });
  });

  it("caps at maxEntries keeping the shallowest entries", () => {
    const capped = mapGitTreeEntries(TREE, 2);
    expect(capped.truncated).toBe(true);
    expect(capped.entries.map((e) => e.path)).toEqual(["apps", "package.json"]);
  });
});

describe("fetchGitTree", () => {
  it("returns metadata, the head commit and the tree", async () => {
    const fetch = mockFetch((url) => {
      if (url.pathname === "/repositories/42") return json(REPO);
      if (url.pathname === "/repos/acme/widget/git/ref/heads/main") return json({ ref: "refs/heads/main", object: { sha: "head1" } });
      if (url.pathname === "/repos/acme/widget/git/trees/head1") {
        expect(url.searchParams.get("recursive")).toBe("1");
        return json(TREE);
      }
      return json({ message: "Not Found" }, { status: 404 });
    });
    const snapshot = await fetchGitTree({ owner: "old", name: "name", repositoryId: 42, octokit: createOctokit({ fetch }) });
    expect(snapshot.repository).toEqual({
      id: 42,
      owner: "acme",
      name: "widget",
      fullName: "acme/widget",
      defaultBranch: "main",
      isPrivate: false,
      htmlUrl: "https://github.com/acme/widget",
    });
    expect(snapshot.commitSha).toBe("head1");
    expect(snapshot.entries).toHaveLength(4);
  });

  it("returns an empty tree for an empty repository", async () => {
    const fetch = mockFetch((url) =>
      url.pathname === "/repos/acme/widget" ? json(REPO) : json({ message: "Git Repository is empty." }, { status: 409 }),
    );
    expect(await fetchGitTree({ owner: "acme", name: "widget", octokit: createOctokit({ fetch }) })).toMatchObject({
      commitSha: null,
      entries: [],
      truncated: false,
    });
  });

  it("maps 404 and rate limits", async () => {
    const missing = mockFetch(() => json({ message: "Not Found" }, { status: 404 }));
    await expect(fetchGitTree({ owner: "acme", name: "widget", octokit: createOctokit({ fetch: missing }) })).rejects.toBeInstanceOf(
      GitHubRepositoryNotFoundError,
    );
    const limited = mockFetch(() =>
      json({ message: "rate limit" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1900000000" } }),
    );
    await expect(fetchGitTree({ owner: "acme", name: "widget", octokit: createOctokit({ fetch: limited }) })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });
});
