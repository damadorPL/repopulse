import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  changedPathsOfPush,
  handleGitHubAppWebhook,
  isDependencyFilePath,
  PayloadTooLargeError,
  readBodyWithLimit,
  WEBHOOK_MAX_BODY_BYTES,
  type WebhookAppSettings,
  type WebhookDeps,
  type WebhookProject,
} from "./github-app-webhook";

const SECRET = "whsec-0123456789abcdef0123456789";
const REPO_ID = 4242;

function stream(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      controller.close();
    },
  });
}

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function delivery(event: string, payload: unknown, opts: { signature?: string | null; headers?: Record<string, string> } = {}) {
  const body = JSON.stringify(payload);
  const headers = new Headers({ "content-type": "application/json", "x-github-event": event, ...opts.headers });
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  if (signature !== null) headers.set("x-hub-signature-256", signature);
  return { headers, body: stream(body) };
}

let settings: WebhookAppSettings;
let projects: (WebhookProject & { githubRepoId: number; defaultBranch: string })[];
let prOwner: string | null;
const enqueueScan = vi.fn(async (_projectId: string) => {});
const findProjectsOnBranch = vi.fn(async (githubRepoId: number, branch: string) =>
  projects.filter((p) => p.githubRepoId === githubRepoId && p.defaultBranch === branch).map(({ id, manifestPaths }) => ({ id, manifestPaths })),
);
const findPrOwnerProjectId = vi.fn(async (_githubRepoId: number) => prOwner);
const loadSettings = vi.fn(async () => settings);
const deps: WebhookDeps = { loadSettings, findProjectsOnBranch, findPrOwnerProjectId, enqueueScan };

beforeEach(() => {
  vi.clearAllMocks();
  settings = { depsEnabled: true, app: { webhookSecret: SECRET } };
  projects = [
    { id: "p-alice", githubRepoId: REPO_ID, defaultBranch: "main", manifestPaths: [] },
    { id: "p-bob", githubRepoId: REPO_ID, defaultBranch: "main", manifestPaths: [] },
    { id: "p-stale", githubRepoId: REPO_ID, defaultBranch: "master", manifestPaths: [] },
    { id: "p-other", githubRepoId: 7, defaultBranch: "main", manifestPaths: [] },
  ];
  prOwner = "p-alice";
});

const push = (files: { added?: string[]; modified?: string[]; removed?: string[] }[], extra: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  before: "a".repeat(40),
  after: "b".repeat(40),
  deleted: false,
  repository: { id: REPO_ID, full_name: "acme/app", default_branch: "main" },
  commits: files.map((f, i) => ({ id: String(i), added: f.added ?? [], modified: f.modified ?? [], removed: f.removed ?? [] })),
  ...extra,
});

describe("isDependencyFilePath", () => {
  it.each([
    "package.json",
    "apps/web/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "bun.lock",
    "bun.lockb",
    "yarn.lock",
    "services/api/pyproject.toml",
    "uv.lock",
    "poetry.lock",
    "requirements.txt",
    "requirements-dev.txt",
    "requirements/base.txt",
    "constraints.txt",
    "requirements.in",
    "deps/dev.in",
  ])("%s is a dependency file", (path) => expect(isDependencyFilePath(path)).toBe(true));

  it.each(["README.md", "src/index.ts", "package.json.bak", "docs/requirements.md", "notes.txt", "pyproject.toml.orig", "lib/package-json.ts"])(
    "%s is not",
    (path) => expect(isDependencyFilePath(path)).toBe(false),
  );
});

describe("changedPathsOfPush", () => {
  it("collects added, modified and removed paths", () => {
    expect(changedPathsOfPush(push([{ added: ["a"], modified: ["b"] }, { removed: ["c"] }]))).toEqual(new Set(["a", "b", "c"]));
  });

  it("is null (unknown: rescan) when the commit list is missing, empty or at GitHub's cap", () => {
    expect(changedPathsOfPush({})).toBeNull();
    expect(changedPathsOfPush({ commits: [] })).toBeNull();
    expect(changedPathsOfPush({ commits: Array.from({ length: 2048 }, () => ({ added: [] })) })).toBeNull();
  });
});

describe("readBodyWithLimit", () => {
  it("concatenates the chunks", async () => {
    expect((await readBodyWithLimit(stream("ab", "cd"), 4)).toString()).toBe("abcd");
    expect((await readBodyWithLimit(null)).length).toBe(0);
  });

  it("stops reading past the limit", async () => {
    await expect(readBodyWithLimit(stream("abc", "de"), 4)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});

describe("handleGitHubAppWebhook: authentication", () => {
  it("answers 413 for a declared or actual body above 5 MiB, before checking anything else", async () => {
    const declared = await handleGitHubAppWebhook(
      { headers: new Headers({ "content-length": String(WEBHOOK_MAX_BODY_BYTES + 1) }), body: stream("{}") },
      deps,
    );
    expect(declared.status).toBe(413);
    const big = new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1);
    const actual = await handleGitHubAppWebhook({ headers: new Headers(), body: stream(big) }, deps);
    expect(actual.status).toBe(413);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  it("answers 404 without an App and 503 without a webhook secret", async () => {
    settings = { depsEnabled: true, app: null };
    expect((await handleGitHubAppWebhook(delivery("push", push([{ modified: ["package.json"] }])), deps)).status).toBe(404);
    settings = { depsEnabled: true, app: { webhookSecret: null } };
    expect((await handleGitHubAppWebhook(delivery("push", push([{ modified: ["package.json"] }])), deps)).status).toBe(503);
    expect(enqueueScan).not.toHaveBeenCalled();
  });

  it("answers 401 for a missing, malformed or wrong signature, and for a tampered body", async () => {
    const payload = push([{ modified: ["package.json"] }]);
    for (const signature of [null, "", "sha1=abc", sign(JSON.stringify(payload), "another-secret-entirely")]) {
      expect((await handleGitHubAppWebhook(delivery("push", payload, { signature }), deps)).status).toBe(401);
    }
    const tampered = delivery("push", payload, { signature: sign(JSON.stringify({ ...payload, ref: "refs/heads/dev" })) });
    expect((await handleGitHubAppWebhook(tampered, deps)).status).toBe(401);
    expect(findProjectsOnBranch).not.toHaveBeenCalled();
    expect(enqueueScan).not.toHaveBeenCalled();
  });

  it("does nothing (204) while the module is disabled", async () => {
    settings = { depsEnabled: false, app: { webhookSecret: SECRET } };
    const result = await handleGitHubAppWebhook(delivery("push", push([{ modified: ["package.json"] }])), deps);
    expect(result.status).toBe(204);
    expect(findProjectsOnBranch).not.toHaveBeenCalled();
    expect(enqueueScan).not.toHaveBeenCalled();
  });

  it("answers 204 to ping and other events", async () => {
    for (const event of ["ping", "installation", "issues", ""]) {
      expect((await handleGitHubAppWebhook(delivery(event, { zen: "hi", repository: { id: REPO_ID } }), deps)).status).toBe(204);
    }
    expect(enqueueScan).not.toHaveBeenCalled();
  });

  it("answers 400 to a signed body that isn't a JSON object", async () => {
    const headers = new Headers({ "x-github-event": "push", "x-hub-signature-256": sign("payload=%7B%7D") });
    expect((await handleGitHubAppWebhook({ headers, body: stream("payload=%7B%7D") }, deps)).status).toBe(400);
  });
});

describe("handleGitHubAppWebhook: push", () => {
  it("rescans every project of the repository on the pushed default branch when a manifest or lockfile changed", async () => {
    const result = await handleGitHubAppWebhook(delivery("push", push([{ modified: ["src/a.ts"] }, { modified: ["pnpm-lock.yaml"] }])), deps);
    expect(result).toEqual({ status: 202, body: { queued: 2 } });
    expect(findProjectsOnBranch).toHaveBeenCalledWith(REPO_ID, "main");
    expect(enqueueScan.mock.calls.map(([id]) => id)).toEqual(["p-alice", "p-bob"]);
  });

  it("ignores pushes that touch no dependency file", async () => {
    const result = await handleGitHubAppWebhook(delivery("push", push([{ added: ["src/a.ts"], removed: ["README.md"] }])), deps);
    expect(result.status).toBe(204);
    expect(enqueueScan).not.toHaveBeenCalled();
  });

  it("honors a project's explicit manifest paths", async () => {
    projects[0]!.manifestPaths = ["deps/tools.txt"];
    const result = await handleGitHubAppWebhook(delivery("push", push([{ modified: ["deps/tools.txt"] }])), deps);
    expect(result).toEqual({ status: 202, body: { queued: 1 } });
    expect(enqueueScan).toHaveBeenCalledWith("p-alice");
  });

  it("rescans when GitHub's commit list may be truncated or is empty", async () => {
    const result = await handleGitHubAppWebhook(delivery("push", push([], { forced: true })), deps);
    expect(result).toEqual({ status: 202, body: { queued: 2 } });
  });

  it("ignores other branches, tags, branch deletions and unknown repositories", async () => {
    const files = [{ modified: ["package.json"] }];
    for (const extra of [{ ref: "refs/heads/feature" }, { ref: "refs/tags/v1.0.0" }, { deleted: true }, { repository: { id: 999 } }, { repository: null }]) {
      expect((await handleGitHubAppWebhook(delivery("push", push(files, extra)), deps)).status).toBe(204);
    }
    expect(enqueueScan).not.toHaveBeenCalled();
  });

  it("matches the branch stored on each project", async () => {
    const result = await handleGitHubAppWebhook(delivery("push", push([{ modified: ["package.json"] }], { ref: "refs/heads/master" })), deps);
    expect(result).toEqual({ status: 202, body: { queued: 1 } });
    expect(enqueueScan).toHaveBeenCalledWith("p-stale");
  });

  it("lets queue errors propagate (the route answers 503)", async () => {
    enqueueScan.mockRejectedValueOnce(new Error("redis down"));
    await expect(handleGitHubAppWebhook(delivery("push", push([{ modified: ["package.json"] }])), deps)).rejects.toThrow("redis down");
  });
});

describe("handleGitHubAppWebhook: pull_request", () => {
  const pr = (action: string, ref: string) => ({
    action,
    number: 12,
    pull_request: { number: 12, merged: action === "closed", head: { ref }, base: { ref: "main" } },
    repository: { id: REPO_ID },
  });

  it("rescans the PR owner's project when a repopulse/deps/* pull request is closed or merged", async () => {
    const result = await handleGitHubAppWebhook(delivery("pull_request", pr("closed", "repopulse/deps/all")), deps);
    expect(result).toEqual({ status: 202, body: { queued: 1 } });
    expect(findPrOwnerProjectId).toHaveBeenCalledWith(REPO_ID);
    expect(enqueueScan).toHaveBeenCalledWith("p-alice");
  });

  it("ignores other actions, other branches and repositories without a PR owner", async () => {
    expect((await handleGitHubAppWebhook(delivery("pull_request", pr("opened", "repopulse/deps/all")), deps)).status).toBe(204);
    expect((await handleGitHubAppWebhook(delivery("pull_request", pr("closed", "feature/x")), deps)).status).toBe(204);
    prOwner = null;
    expect((await handleGitHubAppWebhook(delivery("pull_request", pr("closed", "repopulse/deps/react")), deps)).status).toBe(204);
    expect(enqueueScan).not.toHaveBeenCalled();
  });
});
