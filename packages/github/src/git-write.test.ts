import { describe, expect, it, vi } from "vitest";
import { createOctokit } from "./client.js";
import {
  branchIsBotOwned,
  closePullRequest,
  commitFiles,
  getBranchHead,
  getPullRequestState,
  gitBlobSha,
  inspectBranch,
  readBlobs,
  RefUpdateConflictError,
  treeHasContent,
  treeMatchesFiles,
  upsertPullRequest,
} from "./git-write.js";
import { GitHubRateLimitError } from "./poller.js";

interface Call {
  method: string;
  path: string;
  url: URL;
  body: Record<string, unknown> | undefined;
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...init.headers },
  });
}

const notFound = () => json({ message: "Not Found" }, { status: 404 });

/** A fake GitHub keyed by "METHOD /path" (path decoded); unknown routes answer 404. */
function fakeGitHub(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const call: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      url,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    return handler ? handler(call) : notFound();
  });
  return { octokit: createOctokit({ accessToken: "ghs_test", fetch: fetch as unknown as typeof globalThis.fetch }), calls };
}

const R = "/repos/acme/widget";

describe("gitBlobSha / treeMatchesFiles", () => {
  it("matches git hash-object", () => {
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // Byte length, not string length.
    expect(gitBlobSha("é")).not.toBe(gitBlobSha("e"));
  });

  it("compares blob SHAs per path", () => {
    const tree = [
      { path: "package.json", type: "blob", sha: gitBlobSha("{}\n") },
      { path: "apps", type: "tree", sha: "t" },
    ];
    expect(treeMatchesFiles(tree, [{ path: "package.json", content: "{}\n" }])).toBe(true);
    expect(treeMatchesFiles(tree, [{ path: "package.json", content: "{ }\n" }])).toBe(false);
    expect(treeMatchesFiles(tree, [{ path: "missing.json", content: "{}\n" }])).toBe(false);
  });
});

describe("readBlobs", () => {
  it("decodes base64, keeps order, flags oversize blobs and bounds concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const blobs: Record<string, string> = { a: "alpha", b: "x".repeat(50), c: "gamma", d: "delta", e: "epsilon" };
    const routes: Record<string, () => Promise<Response>> = {};
    for (const [sha, content] of Object.entries(blobs)) {
      routes[`GET ${R}/git/blobs/${sha}`] = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        // GitHub wraps base64 at 60 columns.
        const base64 = Buffer.from(content).toString("base64").replace(/(.{60})/g, "$1\n");
        return json({ sha, size: Buffer.byteLength(content), encoding: "base64", content: base64 });
      };
    }
    const { octokit, calls } = fakeGitHub(routes);
    const result = await readBlobs(
      octokit,
      "acme",
      "widget",
      [
        { path: "a.txt", sha: "a" },
        { path: "b.txt", sha: "b" },
        { path: "big.txt", sha: "z", size: 1_000 },
        { path: "c.txt", sha: "c" },
        { path: "d.txt", sha: "d" },
        { path: "e.txt", sha: "e" },
      ],
      { maxBytes: 20, concurrency: 2 },
    );
    expect(result.map((r) => r.path)).toEqual(["a.txt", "b.txt", "big.txt", "c.txt", "d.txt", "e.txt"]);
    expect(result[0]).toEqual({ path: "a.txt", sha: "a", size: 5, content: "alpha", oversize: false });
    expect(result[1]).toMatchObject({ content: null, oversize: true, size: 50 });
    expect(result[2]).toMatchObject({ content: null, oversize: true, size: 1_000 });
    expect(result[5]?.content).toBe("epsilon");
    expect(calls.some((c) => c.path.endsWith("/z"))).toBe(false);
    expect(maxInFlight).toBe(2);
  });

  it("maps secondary rate limits (retry-after) and rethrows non-rate-limit 403", async () => {
    const { octokit } = fakeGitHub({
      [`GET ${R}/git/blobs/a`]: () => json({ message: "You have exceeded a secondary rate limit" }, { status: 403, headers: { "retry-after": "60" } }),
      [`GET ${R}/git/blobs/b`]: () => json({ message: "Resource not accessible by integration" }, { status: 403 }),
    });
    const error = await readBlobs(octokit, "acme", "widget", [{ path: "a", sha: "a" }], { maxBytes: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);

    const permErr = await readBlobs(octokit, "acme", "widget", [{ path: "b", sha: "b" }], { maxBytes: 10 }).catch((e: unknown) => e);
    expect(permErr).not.toBeInstanceOf(GitHubRateLimitError);
    expect(permErr).toMatchObject({ status: 403 });
  });

  it("handles empty entries, non-base64 encoding, and post-fetch oversize blobs without known size", async () => {
    const { octokit, calls } = fakeGitHub({
      [`GET ${R}/git/blobs/utf8`]: () => json({ sha: "utf8", encoding: "utf-8", content: "hello" }),
      [`GET ${R}/git/blobs/oversize`]: () => json({ sha: "oversize", encoding: "utf-8", content: "x".repeat(50) }),
    });
    await expect(readBlobs(octokit, "acme", "widget", [], { maxBytes: 10 })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);

    const res = await readBlobs(
      octokit,
      "acme",
      "widget",
      [
        { path: "u.txt", sha: "utf8" },
        { path: "o.txt", sha: "oversize" },
      ],
      { maxBytes: 10 },
    );
    expect(res).toEqual([
      { path: "u.txt", sha: "utf8", size: 5, content: "hello", oversize: false },
      { path: "o.txt", sha: "oversize", size: 50, content: null, oversize: true },
    ]);
  });
});

describe("branches", () => {
  const routes = {
    [`GET ${R}/git/ref/heads/repopulse/deps/npm`]: () => json({ ref: "refs/heads/repopulse/deps/npm", object: { sha: "head1", type: "commit" } }),
    [`GET ${R}/git/ref/heads/repopulse/deps/prefix`]: () => json({ ref: "refs/heads/repopulse/deps/prefix-other", object: { sha: "head2", type: "commit" } }),
    [`GET ${R}/git/ref/heads/repopulse/deps/empty`]: () => json({ message: "Git Repository is empty." }, { status: 409 }),
  };

  it("reads the branch head, null when missing, prefix-mismatched or 409", async () => {
    const { octokit } = fakeGitHub(routes);
    await expect(getBranchHead(octokit, "acme", "widget", "repopulse/deps/npm")).resolves.toBe("head1");
    await expect(getBranchHead(octokit, "acme", "widget", "repopulse/deps/pypi")).resolves.toBeNull();
    await expect(getBranchHead(octokit, "acme", "widget", "repopulse/deps/prefix")).resolves.toBeNull();
    await expect(getBranchHead(octokit, "acme", "widget", "repopulse/deps/empty")).resolves.toBeNull();
  });

  it("tells owned, edited and missing branches apart", async () => {
    const { octokit } = fakeGitHub(routes);
    await expect(inspectBranch(octokit, "acme", "widget", "repopulse/deps/npm", "head1")).resolves.toEqual({ status: "owned", headSha: "head1" });
    await expect(inspectBranch(octokit, "acme", "widget", "repopulse/deps/npm", "old")).resolves.toEqual({ status: "edited", headSha: "head1" });
    await expect(inspectBranch(octokit, "acme", "widget", "repopulse/deps/npm", null)).resolves.toMatchObject({ status: "edited" });
    await expect(inspectBranch(octokit, "acme", "widget", "nope", "head1")).resolves.toEqual({ status: "missing" });
    await expect(branchIsBotOwned(octokit, "acme", "widget", "repopulse/deps/npm", "head1")).resolves.toBe(true);
    await expect(branchIsBotOwned(octokit, "acme", "widget", "repopulse/deps/npm", "other")).resolves.toBe(false);
    await expect(branchIsBotOwned(octokit, "acme", "widget", "nope", "head1")).resolves.toBe(false);
  });

  it("checks whether the branch tree already holds the content", async () => {
    const { octokit, calls } = fakeGitHub({
      [`GET ${R}/git/trees/head1`]: () => json({ tree: [{ path: "requirements.txt", type: "blob", sha: gitBlobSha("django==5.2\n") }] }),
      [`GET ${R}/git/trees/emptyrepo`]: () => json({ message: "Git Repository is empty." }, { status: 409 }),
    });
    await expect(treeHasContent(octokit, "acme", "widget", "head1", [])).resolves.toBe(true);
    expect(calls).toHaveLength(0);
    await expect(treeHasContent(octokit, "acme", "widget", "head1", [{ path: "requirements.txt", content: "django==5.2\n" }])).resolves.toBe(true);
    await expect(treeHasContent(octokit, "acme", "widget", "head1", [{ path: "requirements.txt", content: "django==5.3\n" }])).resolves.toBe(false);
    await expect(treeHasContent(octokit, "acme", "widget", "gone", [{ path: "requirements.txt", content: "x" }])).resolves.toBe(false);
    await expect(treeHasContent(octokit, "acme", "widget", "emptyrepo", [{ path: "requirements.txt", content: "x" }])).resolves.toBe(false);
    expect(calls[0]?.url.searchParams.get("recursive")).toBe("1");
  });
});

describe("commitFiles", () => {
  function gitRoutes(refRoutes: Record<string, (call: Call) => Response>) {
    return {
      [`GET ${R}/git/commits/base1`]: () => json({ sha: "base1", tree: { sha: "basetree" } }),
      [`POST ${R}/git/blobs`]: (call: Call) =>
        json({ sha: gitBlobSha(Buffer.from(String(call.body?.content), "base64")) }, { status: 201 }),
      [`POST ${R}/git/trees`]: () => json({ sha: "newtree" }, { status: 201 }),
      [`POST ${R}/git/commits`]: () => json({ sha: "newcommit" }, { status: 201 }),
      ...refRoutes,
    };
  }
  const params = {
    owner: "acme",
    repo: "widget",
    baseSha: "base1",
    branch: "repopulse/deps/npm",
    files: [
      { path: "package.json", content: '{ "name": "ü" }\n' },
      { path: "requirements.txt", content: "django==5.2\n" },
    ],
    message: "chore(deps): update 2 dependencies",
  };

  it("creates blobs, a tree on the base tree, a bot commit and the branch", async () => {
    const { octokit, calls } = fakeGitHub(gitRoutes({ [`POST ${R}/git/refs`]: () => json({ ref: "x" }, { status: 201 }) }));
    await expect(commitFiles(octokit, { ...params, force: false })).resolves.toEqual({ commitSha: "newcommit", treeSha: "newtree" });

    const blobs = calls.filter((c) => c.path === `${R}/git/blobs`);
    expect(blobs.map((c) => Buffer.from(String(c.body?.content), "base64").toString("utf8"))).toEqual(params.files.map((f) => f.content));
    expect(blobs.every((c) => c.body?.encoding === "base64")).toBe(true);

    const tree = calls.find((c) => c.path === `${R}/git/trees`);
    expect(tree?.body).toEqual({
      base_tree: "basetree",
      tree: params.files.map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: gitBlobSha(f.content) })),
    });

    const commit = calls.find((c) => c.method === "POST" && c.path === `${R}/git/commits`);
    expect(commit?.body).toEqual({ message: params.message, tree: "newtree", parents: ["base1"] });
    expect(commit?.body).not.toHaveProperty("author");
    expect(commit?.body).not.toHaveProperty("committer");

    const ref = calls.find((c) => c.path === `${R}/git/refs`);
    expect(ref?.body).toEqual({ ref: "refs/heads/repopulse/deps/npm", sha: "newcommit" });
  });

  it("force-updates an existing branch", async () => {
    const { octokit, calls } = fakeGitHub(gitRoutes({ [`PATCH ${R}/git/refs/heads/repopulse/deps/npm`]: () => json({ ref: "x" }) }));
    await commitFiles(octokit, { ...params, force: true });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ sha: "newcommit", force: true });
  });

  it("awaits durable commit preparation before writing the ref", async () => {
    let persisted = false;
    const { octokit } = fakeGitHub(gitRoutes({ [`POST ${R}/git/refs`]: () => {
      expect(persisted).toBe(true);
      return json({ ref: "x" }, { status: 201 });
    } }));
    await commitFiles(octokit, { ...params, force: false, onPrepared: async (sha) => {
      expect(sha).toBe("newcommit");
      await Promise.resolve();
      persisted = true;
    } });
  });

  it("does not write the ref when durable preparation fails", async () => {
    const { octokit, calls } = fakeGitHub(gitRoutes({}));
    await expect(commitFiles(octokit, { ...params, force: false, onPrepared: async () => {
      throw new Error("Database unavailable");
    } })).rejects.toThrow("Database unavailable");
    expect(calls.some((call) => call.path.includes("/git/refs"))).toBe(false);
  });

  it("creates the branch when a force update finds it deleted", async () => {
    const { octokit, calls } = fakeGitHub(
      gitRoutes({
        [`PATCH ${R}/git/refs/heads/repopulse/deps/npm`]: () => json({ message: "Reference does not exist" }, { status: 422 }),
        [`POST ${R}/git/refs`]: () => json({ ref: "x" }, { status: 201 }),
      }),
    );
    await commitFiles(octokit, { ...params, force: true });
    expect(calls.at(-1)?.method).toBe("POST");
    expect(calls.at(-1)?.path).toBe(`${R}/git/refs`);
  });

  it("surfaces ref races as RefUpdateConflictError and supports executable file mode", async () => {
    const created = fakeGitHub(gitRoutes({ [`POST ${R}/git/refs`]: () => json({ message: "Reference already exists" }, { status: 422 }) }));
    const error = await commitFiles(created.octokit, { ...params, force: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefUpdateConflictError);
    expect((error as RefUpdateConflictError).status).toBe(422);
    expect((error as RefUpdateConflictError).ref).toBe("refs/heads/repopulse/deps/npm");

    const patched = fakeGitHub(gitRoutes({ [`PATCH ${R}/git/refs/heads/repopulse/deps/npm`]: () => json({ message: "conflict" }, { status: 409 }) }));
    await expect(commitFiles(patched.octokit, { ...params, force: true })).rejects.toMatchObject({ name: "RefUpdateConflictError", status: 409 });

    const doubleRace = fakeGitHub(
      gitRoutes({
        [`PATCH ${R}/git/refs/heads/repopulse/deps/npm`]: () => json({ message: "Reference does not exist" }, { status: 422 }),
        [`POST ${R}/git/refs`]: () => json({ message: "Reference already exists" }, { status: 422 }),
      }),
    );
    await expect(commitFiles(doubleRace.octokit, { ...params, force: true })).rejects.toMatchObject({ name: "RefUpdateConflictError", status: 422 });

    const execMode = fakeGitHub(gitRoutes({ [`POST ${R}/git/refs`]: () => json({ ref: "x" }, { status: 201 }) }));
    await commitFiles(execMode.octokit, {
      ...params,
      files: [{ path: "bin/run.sh", content: "#!/bin/sh\n", mode: "100755" }],
      force: false,
    });
    const treeCall = execMode.calls.find((c) => c.path === `${R}/git/trees`);
    expect(treeCall?.body).toMatchObject({ tree: [{ path: "bin/run.sh", mode: "100755", type: "blob" }] });
  });

  it("refuses an empty change", async () => {
    const { octokit } = fakeGitHub({});
    await expect(commitFiles(octokit, { ...params, files: [], force: false })).rejects.toThrow(/at least one file/);
  });
});

describe("pull requests", () => {
  const pr = (number: number, state = "open", ref = "repopulse/deps/npm") => ({
    number,
    state,
    html_url: `https://github.com/acme/widget/pull/${number}`,
    merged: false,
    merged_at: null,
    head: { sha: "head1", ref },
  });
  const input = { owner: "acme", repo: "widget", head: "repopulse/deps/npm", base: "main", title: "Update react", body: "Body" };

  it("updates the known open PR", async () => {
    const { octokit, calls } = fakeGitHub({
      [`GET ${R}/pulls/12`]: () => json(pr(12)),
      [`PATCH ${R}/pulls/12`]: () => json(pr(12)),
    });
    await expect(upsertPullRequest(octokit, { ...input, existingNumber: 12 })).resolves.toEqual({
      number: 12,
      htmlUrl: "https://github.com/acme/widget/pull/12",
      state: "open",
      created: false,
    });
    expect(calls.at(-1)?.body).toEqual({ title: "Update react", body: "Body" });
  });

  it("finds an open PR by head, else opens one", async () => {
    const found = fakeGitHub({
      [`GET ${R}/pulls`]: () => json([pr(7)]),
      [`PATCH ${R}/pulls/7`]: () => json(pr(7)),
    });
    await expect(upsertPullRequest(found.octokit, input)).resolves.toMatchObject({ number: 7, created: false });
    expect(found.calls[0]?.url.searchParams.get("head")).toBe("acme:repopulse/deps/npm");
    expect(found.calls[0]?.url.searchParams.get("state")).toBe("open");

    const fresh = fakeGitHub({
      [`GET ${R}/pulls/3`]: () => json(pr(3, "closed")),
      [`GET ${R}/pulls`]: () => json([]),
      [`POST ${R}/pulls`]: () => json(pr(15), { status: 201 }),
    });
    await expect(upsertPullRequest(fresh.octokit, { ...input, existingNumber: 3 })).resolves.toMatchObject({ number: 15, created: true });
    expect(fresh.calls.at(-1)?.body).toEqual({ head: "repopulse/deps/npm", base: "main", title: "Update react", body: "Body" });
  });

  it("updates the PR another run opened concurrently, or rethrows 422 when none is open", async () => {
    let listed = 0;
    const { octokit } = fakeGitHub({
      [`GET ${R}/pulls`]: () => json(listed++ === 0 ? [] : [pr(9)]),
      [`POST ${R}/pulls`]: () => json({ message: "A pull request already exists for acme:repopulse/deps/npm." }, { status: 422 }),
      [`PATCH ${R}/pulls/9`]: () => json(pr(9)),
    });
    await expect(upsertPullRequest(octokit, input)).resolves.toMatchObject({ number: 9, created: false });

    const { octokit: noPrOctokit } = fakeGitHub({
      [`GET ${R}/pulls`]: () => json([]),
      [`POST ${R}/pulls`]: () => json({ message: "Base branch does not exist" }, { status: 422 }),
    });
    await expect(upsertPullRequest(noPrOctokit, input)).rejects.toMatchObject({ status: 422 });
  });

  it("ignores existingNumber when it returns 404 or has a different head.ref", async () => {
    const { octokit: octokit404 } = fakeGitHub({
      [`GET ${R}/pulls`]: () => json([]),
      [`POST ${R}/pulls`]: () => json(pr(20), { status: 201 }),
    });
    await expect(upsertPullRequest(octokit404, { ...input, existingNumber: 999 })).resolves.toMatchObject({ number: 20, created: true });

    const { octokit: octokitWrongRef } = fakeGitHub({
      [`GET ${R}/pulls/5`]: () => json(pr(5, "open", "other-branch")),
      [`GET ${R}/pulls`]: () => json([]),
      [`POST ${R}/pulls`]: () => json(pr(21), { status: 201 }),
    });
    await expect(upsertPullRequest(octokitWrongRef, { ...input, existingNumber: 5 })).resolves.toMatchObject({ number: 21, created: true });
  });

  it("comments when given, then closes", async () => {
    const { octokit, calls } = fakeGitHub({
      [`POST ${R}/issues/12/comments`]: () => json({ id: 1 }, { status: 201 }),
      [`PATCH ${R}/pulls/12`]: () => json(pr(12, "closed")),
    });
    await closePullRequest(octokit, { owner: "acme", repo: "widget", number: 12, comment: "All updates were applied." });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${R}/issues/12/comments`, `PATCH ${R}/pulls/12`]);
    expect(calls[0]?.body).toEqual({ body: "All updates were applied." });
    expect(calls[1]?.body).toEqual({ state: "closed" });

    calls.length = 0;
    await closePullRequest(octokit, { owner: "acme", repo: "widget", number: 12 });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`PATCH ${R}/pulls/12`]);
  });

  it("reads the PR state, including merged_at fallback when merged is undefined", async () => {
    const { octokit } = fakeGitHub({
      [`GET ${R}/pulls/12`]: () => json({ ...pr(12, "closed"), merged: true, merged_at: "2026-11-01T00:00:00Z" }),
      [`GET ${R}/pulls/14`]: () => json({ ...pr(14, "closed"), merged: undefined, merged_at: "2026-11-01T00:00:00Z" }),
    });
    await expect(getPullRequestState(octokit, "acme", "widget", 12)).resolves.toEqual({
      state: "closed",
      merged: true,
      headSha: "head1",
      headRef: "repopulse/deps/npm",
    });
    await expect(getPullRequestState(octokit, "acme", "widget", 14)).resolves.toMatchObject({ state: "closed", merged: true });
    await expect(getPullRequestState(octokit, "acme", "widget", 13)).resolves.toBeNull();
  });

  it("maps rate limits", async () => {
    const { octokit } = fakeGitHub({
      [`GET ${R}/pulls/12`]: () => json({ message: "rate limited" }, { status: 429 }),
    });
    await expect(getPullRequestState(octokit, "acme", "widget", 12)).rejects.toBeInstanceOf(GitHubRateLimitError);
  });
});
