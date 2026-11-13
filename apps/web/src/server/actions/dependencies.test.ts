import { beforeEach, describe, expect, it, vi } from "vitest";

class UnauthorizedError extends Error {}
class ForbiddenError extends Error {}
class RealtimeUnavailableError extends Error {}

const currentUser = { id: "u1", githubId: "100", githubLogin: "alice", githubAccessTokenEncrypted: null, isSuperAdmin: false };

const prisma = {
  userSubscription: { findMany: vi.fn() },
  dependencyProject: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  dependencyPrOwner: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  dependencyUpdate: { findMany: vi.fn(), updateMany: vi.fn() },
  repository: { findMany: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};

const repoGet = vi.fn();
const queueAdd = vi.fn();
const queueGetJob = vi.fn();
const queues: string[] = [];
const checkRepoAccess = vi.fn();
const isDepsEnabled = vi.fn();
const readLockfileRegenerationAvailable = vi.fn();

vi.mock("@/lib/auth", () => ({ UnauthorizedError, ForbiddenError, getCurrentUserOrThrow: vi.fn(async () => currentUser) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@repopulse/db", () => ({ prisma, decryptToken: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
      queues.push(name);
    }
    add = (...args: unknown[]) => queueAdd(this.name, ...args);
    getJob = (id: string) => queueGetJob(this.name, id);
  },
}));
vi.mock("@repopulse/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repopulse/github")>()),
  createOctokit: vi.fn(() => ({ rest: { repos: { get: repoGet } } })),
  createAppOctokit: vi.fn(),
  getRepoInstallation: vi.fn(async () => null),
}));
vi.mock("@/server/deps-status", () => ({ isDepsEnabled, readLockfileRegenerationAvailable }));
vi.mock("@/server/queries/dependencies", () => ({
  checkRepoAccess,
  loadAppCredentials: vi.fn(async () => ({ state: "not_configured" })),
  userDisplayName: (u: { githubLogin: string | null; name: string | null }) => u.githubLogin ?? u.name ?? "another RepoPulse user",
}));
vi.mock("@/server/realtime", () => ({
  RealtimeUnavailableError,
  getRedis: vi.fn(() => ({})),
  isRealtimeConfigured: vi.fn(() => true),
  withRedisTimeout: <T>(operation: Promise<T>) => operation,
}));

const actions = await import("./dependencies");

function repoData(id: number, fullName: string, isPrivate = false) {
  const [owner, name] = fullName.split("/");
  return { data: { id, name, full_name: fullName, default_branch: "main", private: isPrivate, owner: { login: owner } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  isDepsEnabled.mockResolvedValue(true);
  readLockfileRegenerationAvailable.mockResolvedValue(true);
  queueGetJob.mockResolvedValue(null);
  prisma.dependencyProject.findMany.mockResolvedValue([]);
  prisma.dependencyProject.count.mockResolvedValue(0);
  prisma.dependencyProject.updateMany.mockResolvedValue({ count: 1 });
  prisma.repository.findMany.mockResolvedValue([]);
  prisma.dependencyPrOwner.findUnique.mockResolvedValue(null);
  prisma.dependencyUpdate.findMany.mockResolvedValue([]);
  prisma.dependencyUpdate.updateMany.mockResolvedValue({ count: 0 });
  checkRepoAccess.mockResolvedValue({ ok: true, installationId: 7 });
  let n = 0;
  prisma.dependencyProject.create.mockImplementation(async ({ data }: { data: { fullName: string } }) => ({ id: `p${++n}`, fullName: data.fullName }));
});

describe("addDependencyProjectsAction", () => {
  const subscriptions = [
    { id: "s1", repository: { owner: "acme", name: "web", fullName: "acme/web" } },
    { id: "s2", repository: { owner: "acme", name: "api", fullName: "acme/api" } },
    { id: "s3", repository: { owner: "acme", name: "cli", fullName: "acme/cli" } },
  ];

  it("adds three tracked repositories, links tracked ones and queues their first scans", async () => {
    prisma.userSubscription.findMany.mockResolvedValue(subscriptions);
    repoGet.mockImplementation(async ({ owner, repo }: { owner: string; repo: string }) => repoData({ web: 30, api: 31, cli: 32 }[repo] ?? 0, `${owner}/${repo}`));
    prisma.repository.findMany.mockResolvedValue([{ id: "r-web", githubRepoId: 30 }]);

    const result = await actions.addDependencyProjectsAction({
      sources: [{ subscriptionId: "s1" }, { subscriptionId: "s2" }, { subscriptionId: "s3" }],
      notifyOnFirstScan: true,
    });

    expect(result).toMatchObject({ ok: true, data: { failed: [], existing: [], scansQueued: true } });
    if (!result.ok) throw new Error();
    expect(result.data.added.map((a) => a.fullName)).toEqual(["acme/web", "acme/api", "acme/cli"]);
    expect(prisma.userSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["s1", "s2", "s3"] }, userId: "u1" } }));
    expect(prisma.dependencyProject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u1", fullName: "acme/web", repositoryId: "r-web", updateMode: "NOTIFY", notifyOnFirstScan: true, scanStatus: "QUEUED" }),
      select: { id: true, fullName: true },
    });
    expect(queueAdd).toHaveBeenCalledTimes(3);
    expect(queueAdd).toHaveBeenCalledWith(
      "deps-scan",
      "scan-dependency-project",
      { projectId: "p1", trigger: "add", requestedByUserId: "u1" },
      { jobId: "deps-scan-p1", priority: 1 },
    );
    expect(prisma.dependencyPrOwner.create).not.toHaveBeenCalled();
  });

  it("rejects another user's subscription id", async () => {
    prisma.userSubscription.findMany.mockResolvedValue([]);
    const result = await actions.addDependencyProjectsAction({ sources: [{ subscriptionId: "theirs" }] });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(repoGet).not.toHaveBeenCalled();
    expect(prisma.dependencyProject.create).not.toHaveBeenCalled();
  });

  it("validates the input", async () => {
    expect(await actions.addDependencyProjectsAction({ sources: [] })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await actions.addDependencyProjectsAction({ sources: [{ subscriptionId: "s1" }], userId: "u2" } as never)).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "not a repo" }] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("offers PR modes only for a single repository", async () => {
    const result = await actions.addDependencyProjectsAction({ sources: [{ subscriptionId: "s1" }, { subscriptionId: "s2" }], updateMode: "MANUAL_PR" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("is refused while the module is off", async () => {
    isDepsEnabled.mockResolvedValue(false);
    expect(await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "acme/web" }] })).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  });

  it("reports existing projects instead of duplicating them", async () => {
    repoGet.mockResolvedValue(repoData(5, "acme/web"));
    prisma.dependencyProject.findMany.mockResolvedValue([{ id: "p-old", fullName: "acme/web", githubRepoId: 5 }]);
    const result = await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "https://github.com/acme/web" }] });
    expect(result).toEqual({ ok: true, data: { added: [], existing: [{ projectId: "p-old", fullName: "acme/web" }], failed: [], scansQueued: false } });
    expect(prisma.dependencyProject.create).not.toHaveBeenCalled();
  });

  it("enforces the per-user project limit", async () => {
    repoGet.mockResolvedValue(repoData(5, "acme/web"));
    prisma.dependencyProject.count.mockResolvedValue(50);
    const result = await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "acme/web" }] });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(prisma.dependencyProject.create).not.toHaveBeenCalled();
  });

  it("needs read access through the App for a private repository, and falls back to the App when user token gets 404", async () => {
    repoGet.mockResolvedValueOnce(repoData(5, "acme/secret", true));
    checkRepoAccess.mockResolvedValueOnce({ ok: false, code: "CONFLICT", message: "Install the RepoPulse GitHub App on acme/secret first." });
    const result = await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "acme/secret" }] });
    expect(checkRepoAccess).toHaveBeenCalledWith(currentUser, expect.objectContaining({ githubRepoId: 5 }), "read");
    expect(result).toMatchObject({ ok: true, data: { added: [], failed: [{ source: "acme/secret" }] } });

    // 404 on user token -> falls back to GitHub App installation token
    const github = await import("@repopulse/github");
    const queries = await import("@/server/queries/dependencies");
    repoGet
      .mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404, response: { headers: {} } }))
      .mockResolvedValueOnce(repoData(6, "acme/private-app", true));
    vi.mocked(queries.loadAppCredentials).mockResolvedValueOnce({
      state: "ok",
      app: { auth: { appId: 1, privateKey: "pem" }, slug: "app" },
    });
    vi.mocked(github.getRepoInstallation).mockResolvedValueOnce({ installationId: 77 } as never);
    const appRequest = vi.fn(async () => ({ data: { token: "ghs_inst" } }));
    vi.mocked(github.createAppOctokit).mockReturnValueOnce({ request: appRequest } as never);
    checkRepoAccess.mockResolvedValueOnce({ ok: true, installationId: 77 });

    const fallbackRes = await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "acme/private-app" }] });
    expect(fallbackRes).toMatchObject({
      ok: true,
      data: { added: [{ fullName: "acme/private-app" }], failed: [] },
    });
    expect(appRequest).toHaveBeenCalledWith(
      "POST /app/installations/{installation_id}/access_tokens",
      expect.objectContaining({ installation_id: 77, repositories: ["private-app"] }),
    );
  });

  it("maps P2002 unique constraint violations to CONFLICT", async () => {
    repoGet.mockResolvedValueOnce(repoData(5, "acme/web"));
    prisma.dependencyProject.create.mockRejectedValueOnce({ code: "P2002" });
    const res = await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "acme/web" }] });
    expect(res).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("reports repositories GitHub can't find", async () => {
    repoGet.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404, response: { headers: {} } }));
    const result = await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "acme/missing" }] });
    expect(result).toMatchObject({ ok: true, data: { added: [], failed: [{ source: "acme/missing" }] } });
  });

  it("claims the PR ownership for a single repository in a PR mode, or names the owner", async () => {
    repoGet.mockResolvedValue(repoData(5, "acme/web"));
    const claimed = await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "acme/web" }], updateMode: "MANUAL_PR" });
    expect(claimed).toMatchObject({ ok: true });
    expect(checkRepoAccess).toHaveBeenCalledWith(currentUser, expect.anything(), "write");
    expect(prisma.dependencyPrOwner.create).toHaveBeenCalledWith({ data: { githubRepoId: 5, projectId: "p1" } });

    prisma.dependencyPrOwner.findUnique.mockResolvedValue({ projectId: "other", project: { user: { githubLogin: "bob", name: null } } });
    const conflict = await actions.addDependencyProjectsAction({ sources: [{ repoUrlOrSlug: "acme/web" }], updateMode: "AUTO_PR" });
    expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    if (!conflict.ok) expect(conflict.error.message).toContain("bob");
  });
});

describe("removeDependencyProjectAction", () => {
  it("deletes only the user's project", async () => {
    prisma.dependencyProject.deleteMany.mockResolvedValue({ count: 1 });
    expect(await actions.removeDependencyProjectAction({ projectId: "p1" })).toEqual({ ok: true, data: { projectId: "p1" } });
    expect(prisma.dependencyProject.deleteMany).toHaveBeenCalledWith({ where: { id: "p1", userId: "u1" } });
  });

  it("is NOT_FOUND for another user's project", async () => {
    prisma.dependencyProject.deleteMany.mockResolvedValue({ count: 0 });
    expect(await actions.removeDependencyProjectAction({ projectId: "theirs" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

const storedProject = {
  id: "p1",
  owner: "acme",
  name: "web",
  githubRepoId: 5,
  updateMode: "NOTIFY",
  maxUpdateLevel: "MINOR",
  includePrereleases: false,
  minReleaseAgeDays: 3,
  rangeStrategy: "BUMP",
  ignoreRules: [],
  manifestPaths: [],
  lastScannedAt: null,
  prOwnership: null,
};

describe("updateDependencyProjectSettingsAction", () => {
  it("scopes the lookup to the user", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue(null);
    expect(await actions.updateDependencyProjectSettingsAction({ projectId: "theirs", maxOpenPrs: 3 })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.dependencyProject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "theirs", userId: "u1" } }));
  });

  it("validates fields and ignore rules", async () => {
    expect(await actions.updateDependencyProjectSettingsAction({ projectId: "p1", minReleaseAgeDays: 31 })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await actions.updateDependencyProjectSettingsAction({ projectId: "p1", ignoreRules: [{ name: "re*act" }] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(await actions.updateDependencyProjectSettingsAction({ projectId: "p1", manifestPaths: ["../etc/passwd"] })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
    expect(prisma.dependencyProject.update).not.toHaveBeenCalled();
  });

  it("claims the PR ownership when switching to a PR mode", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue(storedProject);
    const result = await actions.updateDependencyProjectSettingsAction({ projectId: "p1", updateMode: "AUTO_PR" });
    expect(result).toMatchObject({ ok: true, data: { updateMode: "AUTO_PR", rescanQueued: false } });
    expect(checkRepoAccess).toHaveBeenCalledWith(currentUser, storedProject, "write");
    expect(prisma.dependencyPrOwner.create).toHaveBeenCalledWith({ data: { githubRepoId: 5, projectId: "p1" } });
  });

  it("is a CONFLICT naming the owner when another project owns the PRs", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue(storedProject);
    prisma.dependencyPrOwner.findUnique.mockResolvedValue({ projectId: "p9", project: { user: { githubLogin: null, name: "Bob Builder" } } });
    const result = await actions.updateDependencyProjectSettingsAction({ projectId: "p1", updateMode: "MANUAL_PR" });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    if (!result.ok) expect(result.error.message).toContain("Bob Builder");
    expect(prisma.dependencyProject.update).not.toHaveBeenCalled();
  });

  it("refuses a PR mode without write access", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue(storedProject);
    checkRepoAccess.mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "no write" });
    expect(await actions.updateDependencyProjectSettingsAction({ projectId: "p1", updateMode: "MANUAL_PR" })).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "no write" },
    });
  });

  it("releases the ownership when switching back to NOTIFY", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue({ ...storedProject, updateMode: "MANUAL_PR", prOwnership: { projectId: "p1" } });
    expect(await actions.updateDependencyProjectSettingsAction({ projectId: "p1", updateMode: "NOTIFY" })).toMatchObject({ ok: true });
    expect(prisma.dependencyPrOwner.deleteMany).toHaveBeenCalledWith({ where: { projectId: "p1" } });
    expect(checkRepoAccess).not.toHaveBeenCalled();
  });

  it("queues a re-check when the policy changes", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue(storedProject);
    const result = await actions.updateDependencyProjectSettingsAction({ projectId: "p1", maxUpdateLevel: "MAJOR", scanIntervalHours: 6 });
    expect(result).toMatchObject({ ok: true, data: { rescanQueued: true } });
    expect(prisma.dependencyProject.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: expect.objectContaining({ maxUpdateLevel: "MAJOR", scanIntervalHours: 6, nextScanAt: expect.any(Date) }),
    });
    expect(queueAdd).toHaveBeenCalledWith("deps-scan", "scan-dependency-project", expect.objectContaining({ trigger: "manual" }), expect.anything());
  });
});

describe("triggerDependencyScanAction", () => {
  it("is NOT_FOUND for another user's project", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue(null);
    expect(await actions.triggerDependencyScanAction({ projectId: "theirs" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.dependencyProject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "theirs", userId: "u1" } }));
  });

  it("applies the 5-minute cooldown", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue({ id: "p1", fullName: "acme/web", lastScannedAt: new Date(Date.now() - 60_000) });
    const result = await actions.triggerDependencyScanAction({ projectId: "p1" });
    expect(result).toMatchObject({ ok: true, data: { status: "COOLDOWN", fullName: "acme/web" } });
    if (result.ok && result.data.status === "COOLDOWN") expect(result.data.retryAfterSeconds).toBeGreaterThan(200);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("queues a priority scan and marks the project QUEUED", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue({ id: "p1", fullName: "acme/web", lastScannedAt: new Date(Date.now() - 10 * 60_000) });
    expect(await actions.triggerDependencyScanAction({ projectId: "p1" })).toEqual({ ok: true, data: { status: "QUEUED", fullName: "acme/web" } });
    expect(queueAdd).toHaveBeenCalledWith(
      "deps-scan",
      "scan-dependency-project",
      { projectId: "p1", trigger: "manual", requestedByUserId: "u1" },
      { jobId: "deps-scan-p1", priority: 1 },
    );
    expect(prisma.dependencyProject.updateMany).toHaveBeenCalledWith({
      where: { id: "p1", userId: "u1", scanStatus: { not: "SCANNING" } },
      data: { scanStatus: "QUEUED" },
    });
  });
});

describe("createDependencyPullRequestAction", () => {
  const prProject = {
    id: "p1",
    owner: "acme",
    name: "web",
    githubRepoId: 5,
    updateMode: "MANUAL_PR",
    groupMode: "SINGLE",
    maxOpenPrs: 5,
    prOwnership: { projectId: "p1" },
    pullRequests: [],
    updates: [{ name: "react", level: "MINOR", manifest: { path: "package.json", ecosystem: "NPM", packageManager: "NONE", lockfilePath: null } }],
  };

  it("refuses NOTIFY projects", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue({ ...prProject, updateMode: "NOTIFY" });
    expect(await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "all" })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("refuses when another project owns the PRs", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue({ ...prProject, prOwnership: null });
    prisma.dependencyPrOwner.findUnique.mockResolvedValue({ project: { user: { githubLogin: "bob", name: null } } });
    const result = await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "all" });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    if (!result.ok) expect(result.error.message).toContain("bob");
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("is NOT_FOUND for another user's project or an unknown group", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValueOnce(null);
    expect(await actions.createDependencyPullRequestAction({ projectId: "theirs", groupKey: "all" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    prisma.dependencyProject.findFirst.mockResolvedValueOnce(prProject);
    expect(await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "major-react" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "Bad:Key" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("refuses EDITED pull requests", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue({ ...prProject, pullRequests: [{ groupKey: "all", state: "EDITED" }] });
    const result = await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "all" });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    if (!result.ok) expect(result.error.message).toContain("Someone else pushed");
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("refuses check-only package managers and missing write access", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValueOnce({
      ...prProject,
      updates: [{ ...prProject.updates[0], manifest: { ...prProject.updates[0]!.manifest, packageManager: "YARN", lockfilePath: "yarn.lock" } }],
    });
    expect(await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "all" })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    prisma.dependencyProject.findFirst.mockResolvedValueOnce(prProject);
    checkRepoAccess.mockResolvedValueOnce({ ok: false, code: "FORBIDDEN", message: "no write" });
    expect(await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "all" })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("refuses groups that need a lockfile while the sandbox is unreachable", async () => {
    const pnpmProject = {
      ...prProject,
      updates: [{ name: "react", level: "MINOR", manifest: { path: "package.json", ecosystem: "NPM", packageManager: "PNPM", lockfilePath: "pnpm-lock.yaml" } }],
    };
    prisma.dependencyProject.findFirst.mockResolvedValue(pnpmProject);
    checkRepoAccess.mockResolvedValue({ ok: true, installationId: 9 });
    readLockfileRegenerationAvailable.mockResolvedValueOnce(false);
    const refused = await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "all" });
    expect(refused).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    if (!refused.ok) expect(refused.error.message).toContain("pnpm-lock.yaml");
    expect(queueAdd).not.toHaveBeenCalled();

    // Sandbox reachable (heartbeat with a sandbox): queued.
    expect(await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "all" })).toMatchObject({ ok: true });
    expect(queueAdd).toHaveBeenCalledTimes(1);
  });

  it("enqueues deps-update with priority 1 and takes over waiting/prioritized jobs", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue(prProject);
    expect(await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "all" })).toEqual({ ok: true, data: { status: "QUEUED", groupKey: "all" } });
    expect(checkRepoAccess).toHaveBeenCalledWith(currentUser, expect.objectContaining({ githubRepoId: 5 }), "write");
    expect(queueAdd).toHaveBeenCalledWith(
      "deps-update",
      "update-dependency-group",
      { projectId: "p1", groupKey: "all", trigger: "manual" },
      { jobId: "deps-update-p1-all", priority: 1 },
    );

    const changePriority = vi.fn();
    queueGetJob.mockResolvedValueOnce({ getState: vi.fn(async () => "waiting"), changePriority });
    expect(await actions.createDependencyPullRequestAction({ projectId: "p1", groupKey: "all" })).toEqual({
      ok: true,
      data: { status: "QUEUED", groupKey: "all" },
    });
    expect(changePriority).toHaveBeenCalledWith({ priority: 1 });

    // Also verify enqueueScan priority takeover on waiting/prioritized and delayed jobs
    const scanUpdateData = vi.fn();
    const scanChangePriority = vi.fn();
    queueGetJob.mockResolvedValueOnce({ getState: vi.fn(async () => "prioritized"), updateData: scanUpdateData, changePriority: scanChangePriority });
    prisma.dependencyProject.findFirst.mockResolvedValueOnce({ id: "p1", fullName: "acme/web", lastScannedAt: null });
    await actions.triggerDependencyScanAction({ projectId: "p1" });
    expect(scanUpdateData).toHaveBeenCalledWith({ projectId: "p1", trigger: "manual", requestedByUserId: "u1" });
    expect(scanChangePriority).toHaveBeenCalledWith({ priority: 1 });

    const delayedUpdateData = vi.fn();
    const delayedChangePriority = vi.fn();
    queueGetJob.mockResolvedValueOnce({ getState: vi.fn(async () => "delayed"), updateData: delayedUpdateData, changePriority: delayedChangePriority });
    prisma.dependencyProject.findFirst.mockResolvedValueOnce({ id: "p1", fullName: "acme/web", lastScannedAt: null });
    await actions.triggerDependencyScanAction({ projectId: "p1" });
    expect(delayedUpdateData).toHaveBeenCalledTimes(1);
    expect(delayedChangePriority).not.toHaveBeenCalled();
  });
});

describe("createProjectDependencyPullRequestsAction", () => {
  const baseProject = {
    id: "p1",
    owner: "acme",
    name: "web",
    githubRepoId: 5,
    updateMode: "MANUAL_PR",
    groupMode: "SEPARATE_MAJORS",
    maxOpenPrs: 2,
    prOwnership: { projectId: "p1" },
    pullRequests: [],
    updates: [
      { name: "react", level: "MINOR", manifest: { path: "package.json", ecosystem: "NPM", packageManager: "NONE", lockfilePath: null } },
      { name: "vite", level: "MAJOR", manifest: { path: "package.json", ecosystem: "NPM", packageManager: "NONE", lockfilePath: null } },
      { name: "zod", level: "MAJOR", manifest: { path: "package.json", ecosystem: "NPM", packageManager: "NONE", lockfilePath: null } },
    ],
  };

  it("validates input, checks module status, and scopes to the signed-in user", async () => {
    expect(await actions.createProjectDependencyPullRequestsAction({ projectId: "" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });

    prisma.dependencyProject.findFirst.mockResolvedValueOnce(null);
    expect(await actions.createProjectDependencyPullRequestsAction({ projectId: "theirs" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.dependencyProject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "theirs", userId: "u1" } }));

    prisma.dependencyProject.findFirst.mockResolvedValueOnce(baseProject);
    isDepsEnabled.mockResolvedValueOnce(false);
    expect(await actions.createProjectDependencyPullRequestsAction({ projectId: "p1" })).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" },
    });
  });

  it("refuses NOTIFY mode and PR ownership conflicts", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValueOnce({ ...baseProject, updateMode: "NOTIFY" });
    expect(await actions.createProjectDependencyPullRequestsAction({ projectId: "p1" })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });

    prisma.dependencyProject.findFirst.mockResolvedValueOnce({ ...baseProject, prOwnership: null });
    prisma.dependencyPrOwner.findUnique.mockResolvedValueOnce({ project: { user: { githubLogin: "bob", name: null } } });
    const conflict = await actions.createProjectDependencyPullRequestsAction({ projectId: "p1" });
    expect(conflict).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    if (!conflict.ok) expect(conflict.error.message).toContain("bob");
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when nothing is outdated and CONFLICT when every group is blocked", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValueOnce({ ...baseProject, updates: [] });
    expect(await actions.createProjectDependencyPullRequestsAction({ projectId: "p1" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    prisma.dependencyProject.findFirst.mockResolvedValueOnce({
      ...baseProject,
      updates: [{ name: "react", level: "MINOR", manifest: { path: "package.json", ecosystem: "NPM", packageManager: "PNPM", lockfilePath: "pnpm-lock.yaml" } }],
    });
    readLockfileRegenerationAvailable.mockResolvedValueOnce(false);
    const blocked = await actions.createProjectDependencyPullRequestsAction({ projectId: "p1" });
    expect(blocked).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    if (!blocked.ok) expect(blocked.error.message).toContain("pnpm-lock.yaml");
    expect(checkRepoAccess).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("enqueues all eligible groups with a single write check and skips EDITED or slot-limited groups", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValueOnce({
      ...baseProject,
      pullRequests: [{ groupKey: "major-vite", state: "EDITED" }],
    });
    const result = await actions.createProjectDependencyPullRequestsAction({ projectId: "p1" });
    // maxOpenPrs=2 gives slots to "all" and "major-vite"; "major-vite" is EDITED, "major-zod" has no slot.
    expect(result).toEqual({ ok: true, data: { status: "QUEUED", groupKeys: ["all"] } });
    expect(checkRepoAccess).toHaveBeenCalledTimes(1);
    expect(checkRepoAccess).toHaveBeenCalledWith(currentUser, expect.objectContaining({ githubRepoId: 5 }), "write");
    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      "deps-update",
      "update-dependency-group",
      { projectId: "p1", groupKey: "all", trigger: "manual" },
      { jobId: "deps-update-p1-all", priority: 1 },
    );

    vi.clearAllMocks();
    prisma.dependencyProject.findFirst.mockResolvedValueOnce(baseProject);
    const multi = await actions.createProjectDependencyPullRequestsAction({ projectId: "p1" });
    expect(multi).toEqual({ ok: true, data: { status: "QUEUED", groupKeys: ["all", "major-vite"] } });
    expect(checkRepoAccess).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledTimes(2);
  });
});

describe("ignore rules", () => {
  const rows = [
    { id: "d1", name: "react", targetVersion: "18.3.0", latestVersion: "19.0.0", manifest: { ecosystem: "NPM", packageManager: "PNPM" } },
    { id: "d2", name: "react-dom", targetVersion: "18.3.0", latestVersion: "19.0.0", manifest: { ecosystem: "NPM", packageManager: "PNPM" } },
    { id: "d3", name: "Django", targetVersion: null, latestVersion: "5.1", manifest: { ecosystem: "PYPI", packageManager: "UV" } },
    { id: "d4", name: "fastapi", targetVersion: "0.115.2", latestVersion: "0.115.2", manifest: { ecosystem: "PYPI", packageManager: "POETRY" } },
  ];

  it("adds a rule and marks the matching stored rows IGNORED at once", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue({ id: "p1", ignoreRules: [{ name: "vue" }] });
    prisma.dependencyUpdate.findMany.mockResolvedValue(rows);
    prisma.dependencyUpdate.updateMany.mockResolvedValue({ count: 1 });
    const result = await actions.ignoreDependencyAction({ projectId: "p1", name: "react" });
    expect(result).toEqual({ ok: true, data: { ignoreRules: [{ name: "vue" }, { name: "react" }], ignored: 1, rescanQueued: false } });
    expect(prisma.dependencyProject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1", userId: "u1" } }));
    expect(prisma.dependencyProject.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { ignoreRules: [{ name: "vue" }, { name: "react" }] } });
    expect(prisma.dependencyUpdate.updateMany).toHaveBeenCalledWith({
      where: { projectId: "p1", id: { in: ["d1"] } },
      data: { status: "IGNORED", targetVersion: null },
    });
  });

  it("matches globs and version ranges in the row's own syntax (including Poetry caret syntax), then re-checks", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue({ id: "p1", ignoreRules: [] });
    prisma.dependencyUpdate.findMany.mockResolvedValue(rows);
    await actions.ignoreDependencyAction({ projectId: "p1", name: "react*", versions: ">=19" });
    expect(prisma.dependencyUpdate.updateMany).not.toHaveBeenCalled(); // targets 18.3.0 are outside >=19

    await actions.ignoreDependencyAction({ projectId: "p1", name: "react*", versions: "^18" });
    expect(prisma.dependencyUpdate.updateMany).toHaveBeenLastCalledWith({
      where: { projectId: "p1", id: { in: ["d1", "d2"] } },
      data: { status: "IGNORED", targetVersion: null },
    });

    await actions.ignoreDependencyAction({ projectId: "p1", name: "django", versions: ">=5" });
    expect(prisma.dependencyUpdate.updateMany).toHaveBeenLastCalledWith({
      where: { projectId: "p1", id: { in: ["d3"] } },
      data: { status: "IGNORED", targetVersion: null },
    });

    await actions.ignoreDependencyAction({ projectId: "p1", name: "fastapi", versions: "^0.115.0" });
    expect(prisma.dependencyUpdate.updateMany).toHaveBeenLastCalledWith({
      where: { projectId: "p1", id: { in: ["d4"] } },
      data: { status: "IGNORED", targetVersion: null },
    });
    expect(queueAdd).toHaveBeenCalledWith("deps-scan", "scan-dependency-project", expect.objectContaining({ trigger: "manual" }), expect.anything());
  });

  it("validates the pattern, ignores duplicates and caps the rule count", async () => {
    expect(await actions.ignoreDependencyAction({ projectId: "p1", name: "re*act" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    prisma.dependencyProject.findFirst.mockResolvedValueOnce({ id: "p1", ignoreRules: [{ name: "React" }] });
    expect(await actions.ignoreDependencyAction({ projectId: "p1", name: "react" })).toMatchObject({ ok: true, data: { ignored: 0 } });
    prisma.dependencyProject.findFirst.mockResolvedValueOnce({ id: "p1", ignoreRules: Array.from({ length: 50 }, (_, i) => ({ name: `pkg${i}` })) });
    expect(await actions.ignoreDependencyAction({ projectId: "p1", name: "react" })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    prisma.dependencyProject.findFirst.mockResolvedValueOnce(null);
    expect(await actions.ignoreDependencyAction({ projectId: "theirs", name: "react" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(prisma.dependencyProject.update).not.toHaveBeenCalled();
  });

  it("removing a rule rewrites the list and queues a re-check (no cooldown)", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue({ id: "p1", ignoreRules: [{ name: "react" }, { name: "vue", versions: ">=3" }] });
    const result = await actions.removeIgnoreRuleAction({ projectId: "p1", name: "vue", versions: ">=3" });
    expect(result).toEqual({ ok: true, data: { ignoreRules: [{ name: "react" }], ignored: 0, rescanQueued: true } });
    expect(prisma.dependencyProject.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { ignoreRules: [{ name: "react" }] } });
    expect(queueAdd).toHaveBeenCalledWith("deps-scan", "scan-dependency-project", { projectId: "p1", trigger: "manual", requestedByUserId: "u1" }, expect.anything());

    expect(await actions.removeIgnoreRuleAction({ projectId: "p1", name: "angular" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
