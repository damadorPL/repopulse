import { describe, expect, it, vi } from "vitest";
import { createOctokit } from "./client.js";
import { GitHubRateLimitError, GitHubRepositoryNotFoundError } from "./poller.js";
import { fetchRepoTree, mapRepoTree } from "./tree.js";

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

const TREE = {
  truncated: false,
  tree: [
    { path: "README.md", type: "blob" },
    { path: "packages", type: "tree" },
    { path: "packages/cli", type: "tree" },
    { path: "packages/cli/index.ts", type: "blob" },
    { path: "vendor/lib", type: "commit" },
    { path: "vendor", type: "tree" },
    { path: "odd", type: "tag" },
    { type: "blob" },
  ],
};

describe("mapRepoTree", () => {
  it("splits folders and files, sorted, keeping submodules as files", () => {
    expect(mapRepoTree("main", TREE)).toEqual({
      defaultBranch: "main",
      dirs: ["packages", "packages/cli", "vendor"],
      files: ["README.md", "packages/cli/index.ts", "vendor/lib"],
      truncated: false,
    });
  });

  it("keeps the shallowest entries, folders first, when capping", () => {
    expect(mapRepoTree("main", TREE, 4)).toEqual({
      defaultBranch: "main",
      dirs: ["packages", "packages/cli", "vendor"],
      files: ["README.md"],
      truncated: true,
    });
    expect(mapRepoTree("main", TREE, 2).dirs).toEqual(["packages", "vendor"]);
    expect(mapRepoTree("main", TREE, 2).files).toEqual([]);
  });

  it("passes GitHub's truncated flag through", () => {
    expect(mapRepoTree("main", { tree: [], truncated: true }).truncated).toBe(true);
    expect(mapRepoTree("main", {}).truncated).toBe(false);
  });
});

describe("fetchRepoTree", () => {
  it("reads the default branch, then its recursive tree", async () => {
    const fetch = mockFetch((url) => {
      if (url.pathname === "/repos/acme/widget") return json({ default_branch: "trunk" });
      if (url.pathname === "/repos/acme/widget/git/trees/trunk") {
        expect(url.searchParams.get("recursive")).toBe("1");
        return json(TREE);
      }
      return json({ message: "Not Found" }, { status: 404 });
    });
    const tree = await fetchRepoTree({ owner: "acme", name: "widget", octokit: createOctokit({ fetch }) });
    expect(tree.defaultBranch).toBe("trunk");
    expect(tree.dirs).toEqual(["packages", "packages/cli", "vendor"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns an empty tree for an empty repository", async () => {
    const fetch = mockFetch((url) =>
      url.pathname === "/repos/acme/widget"
        ? json({ default_branch: "main" })
        : json({ message: "Git Repository is empty." }, { status: 409 }),
    );
    expect(await fetchRepoTree({ owner: "acme", name: "widget", octokit: createOctokit({ fetch }) })).toEqual({
      defaultBranch: "main",
      dirs: [],
      files: [],
      truncated: false,
    });
  });

  it("maps a missing repository and rate limits", async () => {
    const missing = mockFetch(() => json({ message: "Not Found" }, { status: 404 }));
    await expect(
      fetchRepoTree({ owner: "acme", name: "nope", octokit: createOctokit({ fetch: missing }) }),
    ).rejects.toBeInstanceOf(GitHubRepositoryNotFoundError);

    const limited = mockFetch(() =>
      json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    );
    await expect(
      fetchRepoTree({ owner: "acme", name: "widget", octokit: createOctokit({ fetch: limited }) }),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
  });
});
