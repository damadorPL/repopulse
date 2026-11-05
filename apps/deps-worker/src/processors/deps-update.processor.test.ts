import { describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import type { LockRequest } from "@repopulse/deps";
import { GitHubAppAuthError, GitHubRateLimitError, RefUpdateConflictError } from "@repopulse/github";
import type { DepsUpdateJobData } from "@repopulse/queue";
import { SandboxLockError, type SandboxClient } from "../sandbox-client";
import { createFakeGitHub } from "../testing/fake-github";
import { createFakePrisma, seed, type FakePrisma } from "../testing/fake-prisma";
import { fakeAccess, fakeQueues, fakeRegistry, HASHED_REQUIREMENTS, hex, job, NOW, published, pypiRegistry, version } from "../testing/fixtures";
import { EMPTY_GROUP_COMMENT, processDepsUpdate, workspaceFilePaths } from "./deps-update.processor";

const BRANCH = "repopulse/deps/all";

function seedRows(prisma: FakePrisma, manifest: { path: string; packageManager: string; lockfilePath?: string | null; ecosystem: string }, rows: Array<Record<string, unknown>>) {
  prisma.dependencyManifest.rows.push({ id: "m1", projectId: "p1", blobSha: "x", lockfilePath: null, workspaceRoot: null, dependencyCount: rows.length, warnings: [], ...manifest });
  for (const [index, row] of rows.entries()) {
    prisma.dependencyUpdate.rows.push({ id: `d${index}`, projectId: "p1", manifestId: "m1", kind: "PROD", group: "", status: "OUTDATED", notifiedAt: null, firstSeenAt: NOW, ...row });
  }
}

function setup(options: {
  files?: Record<string, string>;
  project?: Record<string, unknown>;
  user?: Record<string, unknown>;
  owner?: boolean;
  installed?: boolean;
  sandbox?: SandboxClient | null;
  registry?: ReturnType<typeof fakeRegistry>;
} = {}) {
  const prisma = createFakePrisma();
  seed(prisma, { project: { updateMode: "MANUAL_PR", lastScannedAt: NOW, ...options.project }, ...(options.user ? { user: options.user } : {}) });
  if (options.owner !== false) prisma.dependencyPrOwner.rows.push({ githubRepoId: 42, projectId: "p1" });
  prisma.notificationRule.rows.push({ id: "r1", userId: "u1", tagId: null, channel: "SLACK_WEBHOOK", destinationUrl: "https://hooks.slack.com/x", enabled: true, events: ["DEPENDENCY_PULL_REQUESTS"] });
  const files = options.files ?? { "requirements.txt": HASHED_REQUIREMENTS, "README.md": "# widget\n" };
  const github = createFakeGitHub({ files });
  if (!options.files) {
    seedRows(prisma, { path: "requirements.txt", packageManager: "PIP", ecosystem: "PYPI" }, [
      { name: "requests", declared: "==2.31.0", currentVersion: "2.31.0", targetVersion: "2.32.3", level: "MINOR" },
    ]);
  }
  const queues = fakeQueues();
  const deps = {
    prisma: prisma as never,
    redis: queues.redis,
    updateQueue: queues.updateQueue,
    notifyQueue: queues.notifyQueue,
    access: fakeAccess(github, { installed: options.installed ?? true }),
    github: github.api,
    registry: options.registry ?? pypiRegistry(),
    sandbox: options.sandbox ?? null,
    appBaseUrl: "https://pulse.example.com",
    now: () => NOW,
  };
  return { prisma, github, queues, deps };
}

const updateJob = (groupKey = "all") => job<DepsUpdateJobData>({ projectId: "p1", groupKey, trigger: "manual" });

function notifyJobs(queues: ReturnType<typeof fakeQueues>) {
  return queues.notifyQueue.addBulk.mock.calls.flatMap(([jobs]) => jobs.map((j) => j.data as Record<string, unknown>));
}

function commits(github: ReturnType<typeof createFakeGitHub>) {
  return github.state.calls.filter((call) => call.startsWith("commitFiles"));
}

describe("processDepsUpdate: server-side checks", () => {
  it("skips a queued automatic update after switching to manual mode", async () => {
    const { deps, github } = setup({ project: { updateMode: "MANUAL_PR" } });
    const queued = job<DepsUpdateJobData>({ projectId: "p1", groupKey: "all", trigger: "auto" });
    await expect(processDepsUpdate(queued, deps)).resolves.toEqual({ status: "SKIPPED", reason: "MODE_CHANGED" });
    expect(commits(github)).toEqual([]);
  });

  it("rechecks current PR slots for queued groups, while allowing an existing PR to be maintained", async () => {
    const { deps, prisma, github } = setup({
      project: { groupMode: "PER_DEPENDENCY", maxOpenPrs: 2 },
      registry: fakeRegistry({
        "PYPI:requests": [version("2.31.0"), version("2.32.3", 40, { sha256: [hex("c")] })],
        "PYPI:flask": [version("3.0.0"), version("3.1.0")],
      }),
    });
    prisma.dependencyUpdate.rows.push({ id: "flask", projectId: "p1", manifestId: "m1", name: "flask", kind: "PROD", group: "", status: "OUTDATED", declared: "==3.0.0", currentVersion: "3.0.0", targetVersion: "3.1.0", level: "MINOR" });
    // flask sorts first. The queued requests group loses its slot before it executes.
    prisma.dependencyProject.rows[0]!.maxOpenPrs = 1;
    await expect(processDepsUpdate(updateJob("pypi-requests"), deps)).resolves.toEqual({ status: "SKIPPED", reason: "NO_PR_SLOT" });
    expect(commits(github)).toEqual([]);
    prisma.dependencyProject.rows[0]!.maxOpenPrs = 2;
    await expect(processDepsUpdate(updateJob("pypi-requests"), deps)).resolves.toMatchObject({ status: "OPENED" });
    prisma.dependencyProject.rows[0]!.maxOpenPrs = 1;
    await expect(processDepsUpdate(updateJob("pypi-requests"), deps)).resolves.toMatchObject({ status: "UNCHANGED" });
  });

  it("refuses a project in NOTIFY mode", async () => {
    const { deps, queues, github } = setup({ project: { updateMode: "NOTIFY" } });
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(published(queues.redis)).toEqual([expect.objectContaining({ type: "DEPS_PULL_REQUEST_UPDATED", state: "FAILED", message: expect.stringContaining("notify-only") })]);
    expect(commits(github)).toEqual([]);
  });

  it("refuses when another project owns PRs for the repository", async () => {
    const { deps, prisma, github } = setup({ owner: false });
    prisma.dependencyPrOwner.rows.push({ githubRepoId: 42, projectId: "someone-else" });
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("Another RepoPulse user manages pull requests");
    expect(commits(github)).toEqual([]);
  });

  it("switches to NOTIFY, releases ownership and notifies once when the owner lost write access", async () => {
    const { deps, prisma, github, queues } = setup();
    github.state.permissions.set("dev", "read");
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("You no longer have write access to acme/widget. The project was switched to notify-only.");
    expect(prisma.dependencyProject.rows[0]!.updateMode).toBe("NOTIFY");
    expect(prisma.dependencyPrOwner.rows).toEqual([]);
    expect(notifyJobs(queues)).toEqual([expect.objectContaining({ ruleId: "r1", kind: "pull_request", event: "access_lost" })]);
    expect(commits(github)).toEqual([]);
    // The next job stops at the mode check: no second notification.
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("notify-only");
    expect(notifyJobs(queues)).toHaveLength(1);
  });

  it("treats a removed App installation as lost access", async () => {
    const { deps, prisma } = setup({ installed: false });
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("The GitHub App is not installed on acme/widget");
    expect(prisma.dependencyProject.rows[0]!.updateMode).toBe("NOTIFY");
  });

  it("keeps the mode and PR ownership when the App credentials fail (refused, not lost access)", async () => {
    const { deps, prisma, github } = setup();
    deps.access = fakeAccess(github, { installationError: new GitHubAppAuthError("Could not sign a GitHub App token with this private key.") });
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("credentials were rejected");
    expect(prisma.dependencyProject.rows[0]!.updateMode).toBe("MANUAL_PR");
    expect(prisma.dependencyPrOwner.rows).toHaveLength(1);
    expect(commits(github)).toEqual([]);
  });

  it("re-resolves a renamed login from the GitHub id before failing", async () => {
    const { deps, prisma } = setup({ user: { githubLogin: "old-name" } });
    expect(await processDepsUpdate(updateJob(), deps)).toMatchObject({ status: "OPENED" });
    expect(prisma.user.rows[0]!.githubLogin).toBe("dev");
  });

  it("rejects invalid groupKey, empty default branch, retries RefUpdateConflictError once, rate-limits on GitHubRateLimitError, and handles closeEmptyGroup with no open PR or all-skipped updates", async () => {
    const { deps, prisma, github, queues } = setup();

    // 1. Invalid groupKey -> UnrecoverableError
    await expect(processDepsUpdate(updateJob("../invalid"), deps)).rejects.toBeInstanceOf(UnrecoverableError);

    // 2. Single retry on RefUpdateConflictError
    const origCommit = github.raw.commitFiles;
    const commitSpy = vi
      .spyOn(github.raw, "commitFiles")
      .mockRejectedValueOnce(new RefUpdateConflictError("refs/heads/repopulse/deps/all", 422, "conflict"))
      .mockImplementation(origCommit);
    expect(await processDepsUpdate(updateJob(), deps)).toMatchObject({ status: "OPENED" });
    expect(commitSpy).toHaveBeenCalledTimes(2);
    commitSpy.mockRestore();

    // 3. GitHubRateLimitError pauses updateQueue
    const origTree = github.raw.fetchGitTree;
    vi.spyOn(github.raw, "fetchGitTree").mockRejectedValueOnce(new GitHubRateLimitError(new Date(NOW.getTime() + 120_000)));
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toMatchObject({ name: "RateLimitError" });
    expect(queues.updateQueue.rateLimit).toHaveBeenCalledWith(121_000);

    // 4. Empty repository (commitSha: null) -> UnrecoverableError
    vi.spyOn(github.raw, "fetchGitTree").mockImplementationOnce(async (p) => ({ ...(await origTree(p)), commitSha: null }));
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toBeInstanceOf(UnrecoverableError);

    // 5. closeEmptyGroup when no PR is open returns NOTHING_TO_DO
    prisma.dependencyPullRequest.rows = [];
    deps.registry = fakeRegistry({ "PYPI:requests": [version("2.31.0", 300)] });
    expect(await processDepsUpdate(updateJob(), deps)).toEqual({ status: "NOTHING_TO_DO" });

    // 6. All updates in group are manifest-only no-ops (range already satisfies target) -> closeEmptyGroup -> NOTHING_TO_DO
    const noopCtx = setup({
      files: { "requirements.txt": "requests>=2.31.0\n" },
      project: { rangeStrategy: "LOCKFILE_ONLY" },
      registry: fakeRegistry({ "PYPI:requests": [version("2.31.0", 300), version("2.32.3", 40)] }),
    });
    seedRows(noopCtx.prisma, { path: "requirements.txt", packageManager: "PIP", ecosystem: "PYPI" }, [
      { name: "requests", declared: ">=2.31.0", currentVersion: "2.31.0", targetVersion: "2.32.3", level: "MINOR" },
    ]);
    expect(await processDepsUpdate(updateJob(), noopCtx.deps)).toEqual({ status: "NOTHING_TO_DO" });
  });
});

describe("processDepsUpdate: hashed requirements (no lockfile)", () => {
  it("recovers a bot push when the PR API fails before the first PR is saved", async () => {
    const { deps, prisma, github } = setup();
    const upsert = github.raw.upsertPullRequest;
    const spy = vi.spyOn(github.raw, "upsertPullRequest").mockRejectedValueOnce(new Error("GitHub unavailable")).mockImplementation(upsert);
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("GitHub unavailable");
    expect(prisma.dependencyPullRequest.rows).toHaveLength(0);
    expect(prisma.dependencyBranchWriteIntent.rows[0]!.commitSha).toBe(github.branches.get(BRANCH));
    await expect(processDepsUpdate(updateJob(), deps)).resolves.toMatchObject({ status: "OPENED" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(commits(github)).toHaveLength(1);
    expect(prisma.dependencyBranchWriteIntent.rows).toHaveLength(0);
  });

  it("recovers a bot push when persistence of an existing PR fails", async () => {
    const { deps, prisma, github, queues } = setup();
    await processDepsUpdate(updateJob(), deps);
    // A newer target requires a new commit on the existing branch.
    deps.registry = fakeRegistry({ "PYPI:requests": [version("2.31.0"), version("2.33.0", 40, { sha256: [hex("c")] })], "PYPI:flask": [version("3.0.0")] });
    const save = prisma.dependencyPullRequest.upsert;
    vi.spyOn(prisma.dependencyPullRequest, "upsert").mockRejectedValueOnce(new Error("Database unavailable")).mockImplementation(save);
    const previousHead = prisma.dependencyPullRequest.rows[0]!.headSha;
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("Database unavailable");
    expect(github.branches.get(BRANCH)).not.toBe(previousHead);
    await expect(processDepsUpdate(updateJob(), deps)).resolves.toMatchObject({ status: "UPDATED" });
    expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("OPEN");
    expect(prisma.dependencyPullRequest.rows[0]!.headSha).toBe(github.branches.get(BRANCH));
    expect(prisma.dependencyBranchWriteIntent.rows).toHaveLength(0);
    expect(notifyJobs(queues)).toContainEqual(expect.objectContaining({ event: "updated" }));
  });

  it("announces a first PR recovered after its initial persistence failed", async () => {
    const { deps, prisma, github, queues } = setup();
    const save = prisma.dependencyPullRequest.upsert;
    vi.spyOn(prisma.dependencyPullRequest, "upsert").mockRejectedValueOnce(new Error("Database unavailable")).mockImplementation(save);
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("Database unavailable");
    expect(github.prs).toHaveLength(1);
    expect(prisma.dependencyPullRequest.rows).toHaveLength(0);
    await expect(processDepsUpdate(updateJob(), deps)).resolves.toMatchObject({ status: "OPENED" });
    expect(github.prs).toHaveLength(1);
    expect(notifyJobs(queues)).toContainEqual(expect.objectContaining({ event: "opened" }));
  });

  it("preserves human edits after a failed bot push workflow", async () => {
    const { deps, github } = setup();
    vi.spyOn(github.raw, "upsertPullRequest").mockRejectedValueOnce(new Error("GitHub unavailable"));
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("GitHub unavailable");
    github.push(BRANCH, { "human.txt": "do not overwrite" });
    const humanHead = github.branches.get(BRANCH);
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("already exists and was not created by RepoPulse");
    expect(github.branches.get(BRANCH)).toBe(humanHead);
  });

  it("does not push when persisting the write intent fails", async () => {
    const { deps, prisma, github } = setup();
    const save = prisma.dependencyBranchWriteIntent.upsert;
    vi.spyOn(prisma.dependencyBranchWriteIntent, "upsert").mockRejectedValueOnce(new Error("Database unavailable")).mockImplementation(save);
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("Database unavailable");
    expect(github.branches.has(BRANCH)).toBe(false);
    await expect(processDepsUpdate(updateJob(), deps)).resolves.toMatchObject({ status: "OPENED" });
  });

  it("retries from the original bot head when a ref write fails after intent persistence", async () => {
    const { deps, prisma, github } = setup();
    await processDepsUpdate(updateJob(), deps);
    deps.registry = fakeRegistry({ "PYPI:requests": [version("2.31.0"), version("2.33.0", 40, { sha256: [hex("c")] })], "PYPI:flask": [version("3.0.0")] });
    const write = github.raw.commitFiles;
    vi.spyOn(github.raw, "commitFiles").mockImplementationOnce(async (_octokit, params) => {
      await params.onPrepared?.("prepared-but-not-pushed");
      throw new Error("Ref API unavailable");
    }).mockImplementation(write);
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("Ref API unavailable");
    expect(prisma.dependencyBranchWriteIntent.rows[0]!.commitSha).toBe("prepared-but-not-pushed");
    await expect(processDepsUpdate(updateJob(), deps)).resolves.toMatchObject({ status: "UPDATED" });
    expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("OPEN");
  });

  it("retains an unsaved bot head when a later replacement ref write fails", async () => {
    const { deps, prisma, github } = setup();
    const upsert = github.raw.upsertPullRequest;
    vi.spyOn(github.raw, "upsertPullRequest").mockRejectedValueOnce(new Error("PR API unavailable")).mockImplementation(upsert);
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("PR API unavailable");
    const firstHead = github.branches.get(BRANCH);
    expect(prisma.dependencyPullRequest.rows).toHaveLength(0);

    deps.registry = fakeRegistry({ "PYPI:requests": [version("2.31.0"), version("2.33.0", 40, { sha256: [hex("c")] })], "PYPI:flask": [version("3.0.0")] });
    const write = github.raw.commitFiles;
    vi.spyOn(github.raw, "commitFiles").mockImplementationOnce(async (_octokit, params) => {
      await params.onPrepared?.("replacement-not-pushed");
      throw new Error("Ref API unavailable");
    }).mockImplementation(write);
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("Ref API unavailable");
    expect(prisma.dependencyBranchWriteIntent.rows[0]).toMatchObject({ commitSha: "replacement-not-pushed", previousHeadSha: firstHead });
    expect(github.branches.get(BRANCH)).toBe(firstHead);

    await expect(processDepsUpdate(updateJob(), deps)).resolves.toMatchObject({ status: "OPENED" });
    expect(github.files(BRANCH)["requirements.txt"]).toContain("requests==2.33.0");
    expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("OPEN");
    expect(prisma.dependencyBranchWriteIntent.rows).toHaveLength(0);
  });

  it("opens a PR that changes only requirements.txt, with every sha256 of the target, then no-ops", async () => {
    const { deps, prisma, github, queues } = setup();
    const outcome = await processDepsUpdate(updateJob(), deps);
    expect(outcome).toMatchObject({ status: "OPENED", number: 1, files: ["requirements.txt"] });

    const main = github.files("main");
    const branch = github.files(BRANCH);
    const changed = Object.keys(branch).filter((path) => branch[path] !== main[path]);
    expect(changed).toEqual(["requirements.txt"]);
    expect(branch["requirements.txt"]).toBe(`requests==2.32.3 \\\n    --hash=sha256:${hex("c")} \\\n    --hash=sha256:${hex("d")}\nflask==3.0.0\n`);
    expect(github.commitMessage(BRANCH)).toBe("chore(deps): update requests to 2.32.3");

    const [pr] = github.prs;
    expect(pr).toMatchObject({ head: BRANCH, base: "main", title: "chore(deps): update requests to 2.32.3" });
    expect(pr!.body).toContain("<!-- repopulse:deps:all -->");
    expect(pr!.body).toContain("https://pulse.example.com/dependencies/acme/widget");
    expect(pr!.body).not.toContain("inst-token");

    expect(prisma.dependencyPullRequest.rows[0]).toMatchObject({
      groupKey: "all",
      branch: BRANCH,
      number: 1,
      state: "OPEN",
      headSha: github.branches.get(BRANCH),
      targets: ["requirements.txt#requests@2.32.3"],
    });
    expect(published(queues.redis)).toContainEqual(expect.objectContaining({ type: "DEPS_PULL_REQUEST_UPDATED", state: "OPEN", number: 1 }));
    expect(notifyJobs(queues)).toEqual([expect.objectContaining({ event: "opened", prId: prisma.dependencyPullRequest.rows[0]!.id })]);

    // A second run with no new versions: no commit, no new notification.
    expect(await processDepsUpdate(updateJob(), deps)).toMatchObject({ status: "UNCHANGED", number: 1 });
    expect(commits(github)).toHaveLength(1);
    expect(notifyJobs(queues)).toHaveLength(1);
  });

  it("stops for good when someone else pushed to the bot branch", async () => {
    const { deps, prisma, github, queues } = setup();
    await processDepsUpdate(updateJob(), deps);
    github.push(BRANCH, { "requirements.txt": "requests==2.32.3\nflask==3.0.0\n" });
    const humanHead = github.branches.get(BRANCH);

    expect(await processDepsUpdate(updateJob(), deps)).toEqual({ status: "EDITED", number: 1 });
    expect(github.branches.get(BRANCH)).toBe(humanHead);
    expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("EDITED");
    expect(notifyJobs(queues).map((j) => j.event)).toEqual(["opened", "edited"]);
    expect(commits(github)).toHaveLength(1);
  });

  it("closes the PR with a comment when the group became empty", async () => {
    const { deps, prisma, github } = setup();
    await processDepsUpdate(updateJob(), deps);
    deps.registry = fakeRegistry({ "PYPI:requests": [version("2.31.0", 300)] });
    expect(await processDepsUpdate(updateJob(), deps)).toEqual({ status: "CLOSED", number: 1 });
    expect(github.prs[0]).toMatchObject({ state: "closed", comments: [EMPTY_GROUP_COMMENT] });
    expect(prisma.dependencyPullRequest.rows[0]).toMatchObject({ state: "CLOSED", closedAt: NOW });
  });

  it("leaves an edited PR open (EDITED) instead of closing it when the group became empty", async () => {
    const { deps, prisma, github } = setup();
    await processDepsUpdate(updateJob(), deps);
    github.push(BRANCH, { "README.md": "human change" });
    deps.registry = fakeRegistry({ "PYPI:requests": [version("2.31.0", 300)] });
    expect(await processDepsUpdate(updateJob(), deps)).toEqual({ status: "EDITED", number: 1 });
    expect(github.prs[0]).toMatchObject({ state: "open", comments: [] });
    expect(prisma.dependencyPullRequest.rows[0]!.state).toBe("EDITED");
  });

  it("keeps the commit message and title verbatim and puts names in code spans in the body", async () => {
    const { deps, github } = setup({ project: { commitPrefix: "chore(@acme/deps):" } });
    await processDepsUpdate(updateJob(), deps);
    expect(github.commitMessage(BRANCH)).toBe("chore(@acme/deps): update requests to 2.32.3");
    expect(github.prs[0]!.title).toBe("chore(@acme/deps): update requests to 2.32.3");
    expect(github.prs[0]!.title).not.toContain(String.fromCharCode(0x200b));
    expect(github.prs[0]!.body).toContain("| `requests` |");
  });
});

describe("processDepsUpdate: lockfiles through the sandbox", () => {
  const PACKAGE_JSON = `{\n  "name": "widget",\n  "dependencies": {\n    "left-pad": "^1.0.0"\n  }\n}\n`;
  const lock = (leftPad: string, lockfileVersion = 3) =>
    JSON.stringify(
      {
        name: "widget",
        lockfileVersion,
        requires: true,
        packages: { "": { name: "widget", dependencies: { "left-pad": "^1.0.0" } }, "node_modules/left-pad": { version: leftPad } },
      },
      null,
      2,
    ) + "\n";

  function npmSetup(sandbox: SandboxClient | null) {
    const ctx = setup({
      files: { "package.json": PACKAGE_JSON, "package-lock.json": lock("1.0.0"), "src/index.js": "code", "node_modules/x/package.json": "{}" },
      sandbox,
      registry: fakeRegistry({ "NPM:left-pad": [version("1.0.0", 300), version("1.3.0", 40)] }),
    });
    seedRows(ctx.prisma, { path: "package.json", packageManager: "NPM", lockfilePath: "package-lock.json", ecosystem: "NPM" }, [
      { name: "left-pad", declared: "^1.0.0", currentVersion: "1.0.0", targetVersion: "1.3.0", level: "MINOR" },
    ]);
    return ctx;
  }

  function fakeSandbox(respond: (request: LockRequest) => { path: string; text: string }) {
    return { lock: vi.fn(async (request: LockRequest) => respond(request)), health: async () => null } satisfies SandboxClient;
  }

  it("sends the rewritten manifests and the current lockfile, validates and commits both", async () => {
    const sandbox = fakeSandbox((request) => ({ path: request.expectLockfile, text: lock("1.3.0") }));
    const { deps, github } = npmSetup(sandbox);
    expect(await processDepsUpdate(updateJob(), deps)).toMatchObject({ status: "OPENED", files: ["package-lock.json", "package.json"] });

    const request = sandbox.lock.mock.calls[0]![0];
    expect(request).toMatchObject({ packageManager: "NPM", workdir: "", expectLockfile: "package-lock.json", upgrade: [{ name: "left-pad", version: "1.3.0" }], lockfileOnly: false });
    // Workspace manifests and the lockfile only: no source code, nothing from node_modules.
    expect(request.files.map((f) => f.path)).toEqual(["package-lock.json", "package.json"]);
    const sentManifest = Buffer.from(request.files.find((f) => f.path === "package.json")!.contentBase64, "base64").toString("utf8");
    expect(sentManifest).toContain('"left-pad": "^1.3.0"');
    expect(github.files(BRANCH)["package-lock.json"]).toBe(lock("1.3.0"));
  });

  it("rejects a lockfile at another path", async () => {
    const { deps, github } = npmSetup(fakeSandbox(() => ({ path: "other/package-lock.json", text: lock("1.3.0") })));
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("unexpected path");
    expect(commits(github)).toEqual([]);
  });

  it("rejects a lockfile in another format version", async () => {
    const { deps, github } = npmSetup(fakeSandbox((request) => ({ path: request.expectLockfile, text: lock("1.3.0", 2) })));
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("format changed from 3 to 2");
    expect(commits(github)).toEqual([]);
  });

  it("rejects a lockfile that does not resolve the planned version", async () => {
    const { deps } = npmSetup(fakeSandbox((request) => ({ path: request.expectLockfile, text: lock("1.2.0") })));
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("left-pad resolves to 1.2.0 instead of 1.3.0");
  });

  it("keeps the sandbox's stderr in the job log only", async () => {
    const sandbox = {
      lock: vi.fn(async () => {
        throw new SandboxLockError("COMMAND_FAILED", "The package manager could not regenerate the lockfile with these versions.", "npm ERR! secret-ish detail");
      }),
      health: async () => null,
    };
    const { deps, queues } = npmSetup(sandbox);
    const j = updateJob();
    await expect(processDepsUpdate(j, deps)).rejects.toThrow("could not regenerate the lockfile");
    expect(j.log).toHaveBeenCalledWith(expect.stringContaining("npm ERR! secret-ish detail"));
    expect(JSON.stringify(published(queues.redis))).not.toContain("secret-ish");
  });

  it("refuses groups that need a lockfile when no sandbox is configured", async () => {
    const { deps } = npmSetup(null);
    await expect(processDepsUpdate(updateJob(), deps)).rejects.toThrow("Needs a regenerated lockfile");
  });

  it("refuses check-only package managers", async () => {
    const ctx = setup({
      files: { "package.json": PACKAGE_JSON, "yarn.lock": "# yarn lockfile v1\n" },
      registry: fakeRegistry({ "NPM:left-pad": [version("1.0.0", 300), version("1.3.0", 40)] }),
    });
    seedRows(ctx.prisma, { path: "package.json", packageManager: "YARN", lockfilePath: "yarn.lock", ecosystem: "NPM" }, [
      { name: "left-pad", declared: "^1.0.0", targetVersion: "1.3.0", level: "MINOR" },
    ]);
    await expect(processDepsUpdate(updateJob(), ctx.deps)).rejects.toThrow("Yarn projects are check only");
  });
});

describe("workspaceFilePaths", () => {
  it("lists workspace manifests under the lockfile directory, skipping vendored directories", () => {
    const entries = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/web/package.json", "apps/web/src/a.ts", "node_modules/x/package.json", "py/pyproject.toml"].map((path) => ({ path, type: "blob" }));
    expect(workspaceFilePaths(entries, "pnpm-lock.yaml", "PNPM")).toEqual(["apps/web/package.json", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
    expect(workspaceFilePaths(entries, "py/uv.lock", "UV")).toEqual(["py/pyproject.toml", "py/uv.lock"]);
  });

  it("includes registry config so the sandbox can refuse a custom registry", () => {
    const entries = ["package.json", ".npmrc", "package-lock.json", "apps/web/.npmrc", ".env", "py/pyproject.toml", "py/uv.toml", "py/uv.lock"].map((path) => ({
      path,
      type: "blob",
    }));
    expect(workspaceFilePaths(entries, "package-lock.json", "NPM")).toEqual([".npmrc", "apps/web/.npmrc", "package-lock.json", "package.json"]);
    expect(workspaceFilePaths(entries, "py/uv.lock", "UV")).toEqual(["py/pyproject.toml", "py/uv.lock", "py/uv.toml"]);
  });
});
