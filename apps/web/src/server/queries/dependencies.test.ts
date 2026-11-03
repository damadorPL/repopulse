import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = {
  dependencyProject: { findMany: vi.fn(), findFirst: vi.fn() },
  dependencyUpdate: { groupBy: vi.fn() },
  dependencyPrOwner: { findUnique: vi.fn() },
  userSubscription: { findMany: vi.fn() },
  repository: { findUnique: vi.fn() },
  user: { update: vi.fn(() => Promise.resolve()) },
};
const loadGitHubAppSettings = vi.fn();
const github = {
  getRepoInstallation: vi.fn(),
  createInstallationToken: vi.fn(),
  getCollaboratorPermission: vi.fn(),
  getUserLoginById: vi.fn(),
};

class GitHubAppKeyUnreadableError extends Error {}

vi.mock("@repopulse/db", () => ({ prisma, loadGitHubAppSettings, GitHubAppKeyUnreadableError }));
vi.mock("@repopulse/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repopulse/github")>()),
  ...github,
  createOctokit: vi.fn(() => ({})),
}));

const queries = await import("./dependencies");

beforeEach(() => {
  vi.clearAllMocks();
  prisma.dependencyUpdate.groupBy.mockResolvedValue([]);
  prisma.userSubscription.findMany.mockResolvedValue([]);
  prisma.dependencyPrOwner.findUnique.mockResolvedValue(null);
  loadGitHubAppSettings.mockResolvedValue({ appId: 1, slug: "repopulse", privateKey: "pem" });
  github.getRepoInstallation.mockResolvedValue({ installationId: 9, accountLogin: "acme" });
  github.createInstallationToken.mockResolvedValue({ token: "t", expiresAt: new Date() });
});

describe("getDependencyProjects", () => {
  it("is scoped to the user and aggregates outdated counts", async () => {
    prisma.dependencyProject.findMany.mockResolvedValue([
      {
        id: "p1",
        owner: "acme",
        name: "web",
        fullName: "acme/web",
        isPrivate: false,
        repositoryId: "r1",
        updateMode: "NOTIFY",
        lastScannedAt: null,
        scanStatus: "IDLE",
        scanError: null,
        repository: { avatarUrl: "https://a/x.png" },
        manifests: [{ packageManager: "PNPM" }, { packageManager: "PNPM" }, { packageManager: "UV" }],
        pullRequests: [],
      },
    ]);
    prisma.dependencyUpdate.groupBy.mockResolvedValue([
      { projectId: "p1", level: "MAJOR", _count: { _all: 2 } },
      { projectId: "p1", level: "PATCH", _count: { _all: 1 } },
      { projectId: "p1", level: null, _count: { _all: 4 } },
    ]);
    prisma.userSubscription.findMany.mockResolvedValue([{ repositoryId: "r1" }]);

    const [project] = await queries.getDependencyProjects("u1");
    expect(prisma.dependencyProject.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
    expect(prisma.dependencyUpdate.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "OUTDATED", project: { userId: "u1" } } }));
    expect(prisma.userSubscription.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "u1" } }));
    expect(project).toMatchObject({ packageManagers: ["PNPM", "UV"], outdated: { major: 2, minor: 0, patch: 1, other: 4 }, tracked: true });
  });
});

describe("getAddableSubscriptions", () => {
  it("lists the user's subscriptions that are not projects yet", async () => {
    prisma.userSubscription.findMany.mockResolvedValue([
      { id: "s1", repository: { githubRepoId: 1, fullName: "b/one", description: null, avatarUrl: null } },
      { id: "s2", repository: { githubRepoId: 2, fullName: "a/two", description: "d", avatarUrl: null } },
    ]);
    prisma.dependencyProject.findMany.mockResolvedValue([{ githubRepoId: 1 }]);
    expect(await queries.getAddableSubscriptions("u1")).toEqual([{ subscriptionId: "s2", fullName: "a/two", description: "d", avatarUrl: null }]);
    expect(prisma.dependencyProject.findMany).toHaveBeenCalledWith({ where: { userId: "u1" }, select: { githubRepoId: true } });
  });
});

function storedProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    githubRepoId: 5,
    owner: "acme",
    name: "web",
    fullName: "acme/web",
    defaultBranch: "main",
    isPrivate: false,
    repositoryId: null,
    updateMode: "MANUAL_PR",
    maxUpdateLevel: "MINOR",
    includePrereleases: false,
    minReleaseAgeDays: 3,
    groupMode: "SEPARATE_MAJORS",
    rangeStrategy: "BUMP",
    maxOpenPrs: 1,
    scanIntervalHours: 24,
    notificationLevel: "MINOR_AND_UP",
    ignoreRules: [{ name: "vue" }, "junk"],
    manifestPaths: [],
    commitPrefix: "chore(deps):",
    lastScannedAt: new Date(),
    nextScanAt: null,
    scanStatus: "IDLE",
    scanError: null,
    createdAt: new Date(),
    repository: null,
    manifests: [{ id: "m1", path: "package.json", ecosystem: "NPM", packageManager: "NONE", lockfilePath: null, workspaceRoot: null, dependencyCount: 3, warnings: [] }],
    updates: [
      { id: "d1", manifestId: "m1", name: "react", kind: "PROD", group: "", declared: "^18.0.0", currentVersion: "18.0.0", wantedVersion: "18.3.0", targetVersion: "18.3.0", latestVersion: "19.0.0", level: "MINOR", status: "OUTDATED", targetReleasedAt: null, sourceRepoUrl: null },
      { id: "d2", manifestId: "m1", name: "vite", kind: "DEV", group: "", declared: "^5.0.0", currentVersion: "5.0.0", wantedVersion: "5.0.0", targetVersion: "6.0.0", latestVersion: "6.0.0", level: "MAJOR", status: "OUTDATED", targetReleasedAt: null, sourceRepoUrl: null },
      { id: "d3", manifestId: "m1", name: "vue", kind: "PROD", group: "", declared: "^3.0.0", currentVersion: "3.0.0", wantedVersion: null, targetVersion: null, latestVersion: "3.5.0", level: null, status: "IGNORED", targetReleasedAt: null, sourceRepoUrl: null },
    ],
    pullRequests: [],
    ...overrides,
  };
}

describe("getDependencyProject", () => {
  it("looks the project up by user and case-insensitive name", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue(null);
    expect(await queries.getDependencyProject("u2", "Acme", "Web")).toBeNull();
    expect(prisma.dependencyProject.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u2", fullName: { equals: "Acme/Web", mode: "insensitive" } } }),
    );
  });

  it("rejects implausible segments without a query", async () => {
    expect(await queries.getDependencyProject("u1", "..", "web")).toBeNull();
    expect(prisma.dependencyProject.findFirst).not.toHaveBeenCalled();
  });

  it("names another user who owns the PRs and reads ignore rules defensively", async () => {
    prisma.dependencyProject.findFirst.mockResolvedValue(storedProject());
    prisma.dependencyPrOwner.findUnique.mockResolvedValue({ projectId: "p9", project: { user: { githubLogin: "bob", name: null } } });
    const project = await queries.getDependencyProject("u1", "acme", "web");
    expect(project?.prOwner).toEqual({ kind: "other", ownerName: "bob" });
    expect(project?.settings.ignoreRules).toEqual([{ name: "vue" }]);
    expect(project?.updates[0]).toMatchObject({ manifestPath: "package.json", ecosystem: "NPM" });
  });
});

describe("planPullRequests", () => {
  async function load(overrides: Record<string, unknown> = {}, owner: unknown = { projectId: "p1", project: { user: { githubLogin: "me", name: null } } }) {
    prisma.dependencyProject.findFirst.mockResolvedValue(storedProject(overrides));
    prisma.dependencyPrOwner.findUnique.mockResolvedValue(owner);
    return (await queries.getDependencyProject("u1", "acme", "web"))!;
  }
  const installed = { state: "installed" as const, installationId: 9, accountLogin: "acme" };
  const sandbox = { lockfileRegeneration: true };

  it("groups OUTDATED rows (majors last) and gives the slot to the first group", async () => {
    const plans = queries.planPullRequests(await load(), installed, sandbox);
    expect(plans.map((p) => [p.groupKey, p.disabledReason === null])).toEqual([
      ["all", true],
      ["major-vite", false],
    ]);
    expect(plans[1]!.disabledReason).toContain("free slot");
    expect(plans[0]!.updates).toEqual([{ name: "react", manifestPath: "package.json", from: "18.0.0", to: "18.3.0", level: "MINOR" }]);
  });

  it("explains why Create PR is disabled", async () => {
    expect(queries.planPullRequests(await load({ updateMode: "NOTIFY" }), installed, sandbox)[0]!.disabledReason).toContain("only notifies");
    expect(queries.planPullRequests(await load(), { state: "not_configured" }, sandbox)[0]!.disabledReason).toContain("not set up");
    expect(queries.planPullRequests(await load(), { state: "not_installed", installUrl: "x" }, sandbox)[0]!.disabledReason).toContain("Install");
    expect(queries.planPullRequests(await load({}, { projectId: "p9", project: { user: { githubLogin: "bob", name: null } } }), installed, sandbox)[0]!.disabledReason).toContain("bob");
    const yarn = await load({ manifests: [{ id: "m1", path: "package.json", ecosystem: "NPM", packageManager: "YARN", lockfilePath: "yarn.lock", workspaceRoot: null, dependencyCount: 3, warnings: [] }] });
    expect(queries.planPullRequests(yarn, installed, sandbox)[0]!.disabledReason).toContain("Yarn");
  });

  it("disables lockfile groups while the sandbox is unreachable", async () => {
    const pnpm = async () =>
      load({ manifests: [{ id: "m1", path: "package.json", ecosystem: "NPM", packageManager: "PNPM", lockfilePath: "pnpm-lock.yaml", workspaceRoot: null, dependencyCount: 3, warnings: [] }] });
    expect(queries.planPullRequests(await pnpm(), installed, { lockfileRegeneration: false })[0]!.disabledReason).toContain("pnpm-lock.yaml");
    expect(queries.planPullRequests(await pnpm(), installed, sandbox)[0]!.disabledReason).toBeNull();
  });
});

describe("checkRepoAccess", () => {
  const user = { id: "u1", githubId: "100", githubLogin: "alice" };
  const repo = { owner: "acme", name: "web", githubRepoId: 5 };

  it("needs the App configured and installed", async () => {
    loadGitHubAppSettings.mockResolvedValueOnce(null);
    expect(await queries.checkRepoAccess(user, repo, "read")).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    github.getRepoInstallation.mockResolvedValueOnce(null);
    expect(await queries.checkRepoAccess(user, repo, "read")).toMatchObject({ ok: false, code: "CONFLICT" });
  });

  it("checks the user's permission with a token narrowed to the repository", async () => {
    github.getCollaboratorPermission.mockResolvedValue("read");
    expect(await queries.checkRepoAccess(user, repo, "read")).toEqual({ ok: true, installationId: 9 });
    expect(github.createInstallationToken).toHaveBeenCalledWith(expect.anything(), 9, { repositoryIds: [5], permissions: { metadata: "read" } }, expect.anything());
    expect(await queries.checkRepoAccess(user, repo, "write")).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("re-resolves a changed login on a 404", async () => {
    github.getCollaboratorPermission.mockResolvedValueOnce(null).mockResolvedValueOnce("admin");
    github.getUserLoginById.mockResolvedValue("alice-new");
    expect(await queries.checkRepoAccess(user, repo, "write")).toEqual({ ok: true, installationId: 9 });
    expect(github.getCollaboratorPermission).toHaveBeenLastCalledWith(expect.anything(), "acme", "web", "alice-new");
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { githubLogin: "alice-new" } });
  });

  it("reports an unreadable App key", async () => {
    loadGitHubAppSettings.mockRejectedValueOnce(new GitHubAppKeyUnreadableError());
    expect(await queries.checkRepoAccess(user, repo, "read")).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });
});
