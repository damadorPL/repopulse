import { cache } from "react";
import {
  GitHubAppKeyUnreadableError,
  loadGitHubAppSettings,
  prisma,
  type DependencyEcosystem,
  type DependencyKind,
  type DependencyUpdateStatus,
  type DepsGroupMode,
  type DepsPrState,
  type DepsRangeStrategy,
  type DepsScanStatus,
  type DepsUpdateLevel,
  type DepsUpdateMode,
  type NotificationLevel,
  type PackageManager,
  type SemverType,
  type User as DbUser,
} from "@repopulse/db";
import {
  createInstallationToken,
  createOctokit,
  getCollaboratorPermission,
  getRepoInstallation,
  getUserLoginById,
  GitHubAppAuthError,
  GitHubAppInstallationError,
  installUrl,
  permissionAtLeast,
  type GitHubAppAuth,
} from "@repopulse/github";
import { groupCapability, groupUpdates } from "@repopulse/deps";
import type { ActionErrorCode } from "@/server/action-result";
import { readIgnoreRules, type IgnoreRuleValue, type LevelCounts } from "@/lib/dependency-settings";
import { parseRepoSegment } from "./repository-settings";

/**
 * Read queries of the Dependencies pages (Slice 08) and the server-only GitHub App checks shared by
 * the pages and `server/actions/dependencies.ts`. Every project query is scoped to `userId`: another
 * user's project resolves to `null` (→ `notFound()`). Not a `"use server"` module.
 */

/** GitHub calls made while rendering a page or running an action must not hang. */
const GITHUB_TIMEOUT_MS = 8_000;

function timedFetch(ms = GITHUB_TIMEOUT_MS): typeof globalThis.fetch {
  return (input, init) => globalThis.fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) });
}

/** Owner avatar: the tracked repository's, else GitHub's avatar redirect for the login. */
function ownerAvatar(owner: string, repositoryAvatar: string | null | undefined): string {
  return repositoryAvatar ?? `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}`;
}

function emptyCounts(): LevelCounts {
  return { major: 0, minor: 0, patch: 0, other: 0 };
}

function addLevel(counts: LevelCounts, level: SemverType | null, count: number): void {
  if (level === "MAJOR") counts.major += count;
  else if (level === "MINOR") counts.minor += count;
  else if (level === "PATCH") counts.patch += count;
  else counts.other += count;
}

/** Display name of a user for "PRs are managed by …". */
export function userDisplayName(user: { githubLogin: string | null; name: string | null }): string {
  return user.githubLogin ?? user.name ?? "another RepoPulse user";
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface DependencyProjectListItem {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  avatarUrl: string;
  isPrivate: boolean;
  packageManagers: PackageManager[];
  outdated: LevelCounts;
  openPullRequests: Array<{ id: string; number: number; htmlUrl: string; groupKey: string }>;
  updateMode: DepsUpdateMode;
  groupMode: DepsGroupMode;
  maxOpenPrs: number;
  prOwner: PrOwnerView;
  manifests: Array<Pick<DependencyManifestView, "id" | "path" | "ecosystem" | "packageManager" | "lockfilePath">>;
  outdatedUpdates: Array<
    Pick<DependencyUpdateView, "manifestId" | "manifestPath" | "ecosystem" | "name" | "currentVersion" | "targetVersion" | "level" | "status">
  >;
  pullRequests: Array<Pick<DependencyPullRequestView, "groupKey" | "number" | "htmlUrl" | "state">>;
  lastScannedAt: Date | null;
  scanStatus: DepsScanStatus;
  scanError: string | null;
  /** The user tracks this repository's releases ("Tracked" badge). */
  tracked: boolean;
}

export async function getDependencyProjects(userId: string): Promise<DependencyProjectListItem[]> {
  const [projects, counts, subscriptions] = await Promise.all([
    prisma.dependencyProject.findMany({
      where: { userId },
      orderBy: { fullName: "asc" },
      select: {
        id: true,
        githubRepoId: true,
        owner: true,
        name: true,
        fullName: true,
        isPrivate: true,
        repositoryId: true,
        updateMode: true,
        groupMode: true,
        maxOpenPrs: true,
        lastScannedAt: true,
        scanStatus: true,
        scanError: true,
        prOwnership: { select: { projectId: true } },
        repository: { select: { avatarUrl: true } },
        manifests: { select: { id: true, path: true, ecosystem: true, packageManager: true, lockfilePath: true } },
        updates: {
          where: { status: "OUTDATED" },
          orderBy: [{ name: "asc" }, { kind: "asc" }],
          select: { manifestId: true, name: true, currentVersion: true, targetVersion: true, level: true, status: true },
        },
        pullRequests: {
          orderBy: { openedAt: "asc" },
          select: { id: true, number: true, htmlUrl: true, groupKey: true, state: true },
        },
      },
    }),
    prisma.dependencyUpdate.groupBy({
      by: ["projectId", "level"],
      where: { status: "OUTDATED", project: { userId } },
      _count: { _all: true },
    }),
    prisma.userSubscription.findMany({ where: { userId }, select: { repositoryId: true } }),
  ]);

  const unownedRepoIds = [
    ...new Set(
      projects
        .filter((project) => project.updateMode !== "NOTIFY" && !project.prOwnership && typeof project.githubRepoId === "number")
        .map((project) => project.githubRepoId),
    ),
  ];
  const owners =
    unownedRepoIds.length > 0
      ? await prisma.dependencyPrOwner.findMany({
          where: { githubRepoId: { in: unownedRepoIds } },
          select: { githubRepoId: true, projectId: true, project: { select: { user: { select: { githubLogin: true, name: true } } } } },
        })
      : [];
  const ownerByRepoId = new Map(owners.map((owner) => [owner.githubRepoId, owner]));

  const tracked = new Set(subscriptions.map((s) => s.repositoryId));
  const outdated = new Map<string, LevelCounts>();
  for (const row of counts) {
    const entry = outdated.get(row.projectId) ?? emptyCounts();
    addLevel(entry, row.level, row._count._all);
    outdated.set(row.projectId, entry);
  }
  return projects.map((project) => {
    const manifestById = new Map(project.manifests.map((m) => [m.id ?? m.packageManager, m]));
    const ownerRecord = project.prOwnership ? null : ownerByRepoId.get(project.githubRepoId);
    const prOwner: PrOwnerView = project.prOwnership
      ? { kind: "self" }
      : ownerRecord
        ? ownerRecord.projectId === project.id
          ? { kind: "self" }
          : { kind: "other", ownerName: userDisplayName(ownerRecord.project.user) }
        : { kind: "none" };
    return {
      id: project.id,
      owner: project.owner,
      name: project.name,
      fullName: project.fullName,
      avatarUrl: ownerAvatar(project.owner, project.repository?.avatarUrl),
      isPrivate: project.isPrivate,
      packageManagers: [...new Set(project.manifests.map((m) => m.packageManager))].sort(),
      outdated: outdated.get(project.id) ?? emptyCounts(),
      openPullRequests: project.pullRequests
        .filter((pr) => (pr.state ?? "OPEN") === "OPEN")
        .map((pr) => ({ id: pr.id, number: pr.number, htmlUrl: pr.htmlUrl, groupKey: pr.groupKey })),
      updateMode: project.updateMode,
      groupMode: project.groupMode ?? "SEPARATE_MAJORS",
      maxOpenPrs: project.maxOpenPrs ?? 5,
      prOwner,
      manifests: project.manifests.map((m) => ({
        id: m.id ?? m.packageManager,
        path: m.path ?? "",
        ecosystem: m.ecosystem ?? "NPM",
        packageManager: m.packageManager,
        lockfilePath: m.lockfilePath ?? null,
      })),
      outdatedUpdates: (project.updates ?? []).map((u) => {
        const manifest = manifestById.get(u.manifestId);
        return {
          manifestId: u.manifestId,
          manifestPath: manifest?.path ?? "",
          ecosystem: manifest?.ecosystem ?? "NPM",
          name: u.name,
          currentVersion: u.currentVersion,
          targetVersion: u.targetVersion,
          level: u.level,
          status: u.status,
        };
      }),
      pullRequests: project.pullRequests.map((pr) => ({
        groupKey: pr.groupKey,
        number: pr.number,
        htmlUrl: pr.htmlUrl,
        state: pr.state ?? "OPEN",
      })),
      lastScannedAt: project.lastScannedAt,
      scanStatus: project.scanStatus,
      scanError: project.scanError,
      tracked: project.repositoryId !== null && tracked.has(project.repositoryId),
    };
  });
}

export interface AddableSubscription {
  subscriptionId: string;
  fullName: string;
  description: string | null;
  avatarUrl: string | null;
}

/** The user's tracked repositories that are not dependency projects yet (Add dialog, first tab). */
export async function getAddableSubscriptions(userId: string): Promise<AddableSubscription[]> {
  const [subscriptions, projects] = await Promise.all([
    prisma.userSubscription.findMany({
      where: { userId },
      select: { id: true, repository: { select: { githubRepoId: true, fullName: true, description: true, avatarUrl: true } } },
    }),
    prisma.dependencyProject.findMany({ where: { userId }, select: { githubRepoId: true } }),
  ]);
  const taken = new Set(projects.map((p) => p.githubRepoId));
  return subscriptions
    .filter((s) => !taken.has(s.repository.githubRepoId))
    .map((s) => ({
      subscriptionId: s.id,
      fullName: s.repository.fullName,
      description: s.repository.description,
      avatarUrl: s.repository.avatarUrl,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export interface DependencyManifestView {
  id: string;
  path: string;
  ecosystem: DependencyEcosystem;
  packageManager: PackageManager;
  lockfilePath: string | null;
  workspaceRoot: string | null;
  dependencyCount: number;
  warnings: string[];
}

export interface DependencyUpdateView {
  id: string;
  manifestId: string;
  manifestPath: string;
  ecosystem: DependencyEcosystem;
  name: string;
  kind: DependencyKind;
  group: string;
  declared: string;
  currentVersion: string | null;
  wantedVersion: string | null;
  targetVersion: string | null;
  latestVersion: string | null;
  level: SemverType | null;
  status: DependencyUpdateStatus;
  targetReleasedAt: Date | null;
  sourceRepoUrl: string | null;
}

export interface DependencyPullRequestView {
  id: string;
  groupKey: string;
  branch: string;
  number: number;
  htmlUrl: string;
  state: DepsPrState;
  targets: string[];
  openedAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export interface DependencyProjectSettings {
  updateMode: DepsUpdateMode;
  maxUpdateLevel: DepsUpdateLevel;
  includePrereleases: boolean;
  minReleaseAgeDays: number;
  groupMode: DepsGroupMode;
  rangeStrategy: DepsRangeStrategy;
  maxOpenPrs: number;
  scanIntervalHours: number;
  notificationLevel: NotificationLevel;
  ignoreRules: IgnoreRuleValue[];
  manifestPaths: string[];
  commitPrefix: string;
}

export type PrOwnerView =
  | { kind: "none" }
  | { kind: "self" }
  /** Another user's project opens the PRs of this repository. */
  | { kind: "other"; ownerName: string };

export interface DependencyProjectDetail {
  id: string;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  avatarUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  repositoryId: string | null;
  tracked: boolean;
  settings: DependencyProjectSettings;
  lastScannedAt: Date | null;
  nextScanAt: Date | null;
  scanStatus: DepsScanStatus;
  scanError: string | null;
  createdAt: Date;
  manifests: DependencyManifestView[];
  updates: DependencyUpdateView[];
  pullRequests: DependencyPullRequestView[];
  prOwner: PrOwnerView;
  /** Lower-cased full names of every repository the user tracks ("Track releases" is hidden for them). */
  trackedFullNames: string[];
}

/**
 * The signed-in user's project `owner/name` (case-insensitive), or `null` when the user has no such
 * project. Rows of another user can never match: `userId` is part of the lookup.
 */
export async function getDependencyProject(userId: string, owner: string, name: string): Promise<DependencyProjectDetail | null> {
  const ownerName = parseRepoSegment(owner);
  const repoName = parseRepoSegment(name);
  if (!ownerName || !repoName) return null;

  const project = await prisma.dependencyProject.findFirst({
    where: { userId, fullName: { equals: `${ownerName}/${repoName}`, mode: "insensitive" } },
    include: {
      repository: { select: { avatarUrl: true } },
      manifests: { orderBy: { path: "asc" } },
      updates: { orderBy: [{ name: "asc" }, { kind: "asc" }] },
      pullRequests: { orderBy: { openedAt: "desc" } },
    },
  });
  if (!project) return null;

  const [owner_, subscriptions] = await Promise.all([
    prisma.dependencyPrOwner.findUnique({
      where: { githubRepoId: project.githubRepoId },
      select: { projectId: true, project: { select: { user: { select: { githubLogin: true, name: true } } } } },
    }),
    prisma.userSubscription.findMany({ where: { userId }, select: { repositoryId: true, repository: { select: { fullName: true } } } }),
  ]);
  const manifestById = new Map(project.manifests.map((m) => [m.id, m]));
  const prOwner: PrOwnerView = !owner_
    ? { kind: "none" }
    : owner_.projectId === project.id
      ? { kind: "self" }
      : { kind: "other", ownerName: userDisplayName(owner_.project.user) };

  return {
    id: project.id,
    githubRepoId: project.githubRepoId,
    owner: project.owner,
    name: project.name,
    fullName: project.fullName,
    avatarUrl: ownerAvatar(project.owner, project.repository?.avatarUrl),
    defaultBranch: project.defaultBranch,
    isPrivate: project.isPrivate,
    repositoryId: project.repositoryId,
    tracked: project.repositoryId !== null && subscriptions.some((s) => s.repositoryId === project.repositoryId),
    settings: {
      updateMode: project.updateMode,
      maxUpdateLevel: project.maxUpdateLevel,
      includePrereleases: project.includePrereleases,
      minReleaseAgeDays: project.minReleaseAgeDays,
      groupMode: project.groupMode,
      rangeStrategy: project.rangeStrategy,
      maxOpenPrs: project.maxOpenPrs,
      scanIntervalHours: project.scanIntervalHours,
      notificationLevel: project.notificationLevel,
      ignoreRules: readIgnoreRules(project.ignoreRules),
      manifestPaths: project.manifestPaths,
      commitPrefix: project.commitPrefix,
    },
    lastScannedAt: project.lastScannedAt,
    nextScanAt: project.nextScanAt,
    scanStatus: project.scanStatus,
    scanError: project.scanError,
    createdAt: project.createdAt,
    manifests: project.manifests.map((m) => ({
      id: m.id,
      path: m.path,
      ecosystem: m.ecosystem,
      packageManager: m.packageManager,
      lockfilePath: m.lockfilePath,
      workspaceRoot: m.workspaceRoot,
      dependencyCount: m.dependencyCount,
      warnings: m.warnings,
    })),
    updates: project.updates.map((u) => {
      const manifest = manifestById.get(u.manifestId);
      return {
        id: u.id,
        manifestId: u.manifestId,
        manifestPath: manifest?.path ?? "",
        ecosystem: manifest?.ecosystem ?? "NPM",
        name: u.name,
        kind: u.kind,
        group: u.group,
        declared: u.declared,
        currentVersion: u.currentVersion,
        wantedVersion: u.wantedVersion,
        targetVersion: u.targetVersion,
        latestVersion: u.latestVersion,
        level: u.level,
        status: u.status,
        targetReleasedAt: u.targetReleasedAt,
        sourceRepoUrl: u.sourceRepoUrl,
      };
    }),
    pullRequests: project.pullRequests.map((pr) => ({
      id: pr.id,
      groupKey: pr.groupKey,
      branch: pr.branch,
      number: pr.number,
      htmlUrl: pr.htmlUrl,
      state: pr.state,
      targets: pr.targets,
      openedAt: pr.openedAt,
      updatedAt: pr.updatedAt,
      closedAt: pr.closedAt,
    })),
    prOwner,
    trackedFullNames: subscriptions.map((s) => s.repository.fullName.toLowerCase()),
  };
}

export interface RepositoryDependencySummary {
  projectId: string;
  fullName: string;
  outdated: LevelCounts;
  lastScannedAt: Date | null;
  scanStatus: DepsScanStatus;
}

/** The user's project for a tracked repository (repository settings card), or `null`. */
export async function getDependencyProjectForRepository(userId: string, repositoryId: string): Promise<RepositoryDependencySummary | null> {
  const repository = await prisma.repository.findUnique({ where: { id: repositoryId }, select: { githubRepoId: true } });
  if (!repository) return null;
  const project = await prisma.dependencyProject.findFirst({
    where: { userId, OR: [{ githubRepoId: repository.githubRepoId }, { repositoryId }] },
    select: { id: true, fullName: true, lastScannedAt: true, scanStatus: true },
  });
  if (!project) return null;
  const counts = await prisma.dependencyUpdate.groupBy({
    by: ["level"],
    where: { projectId: project.id, status: "OUTDATED" },
    _count: { _all: true },
  });
  const outdated = emptyCounts();
  for (const row of counts) addLevel(outdated, row.level, row._count._all);
  return { projectId: project.id, fullName: project.fullName, outdated, lastScannedAt: project.lastScannedAt, scanStatus: project.scanStatus };
}

// ---------------------------------------------------------------------------
// GitHub App (server-only, shared by pages and actions)
// ---------------------------------------------------------------------------

export interface AppCredentials {
  auth: GitHubAppAuth;
  slug: string;
}

export type AppCredentialsResult =
  | { state: "ok"; app: AppCredentials }
  | { state: "not_configured" }
  /** The stored key can't be decrypted (`TOKEN_ENCRYPTION_KEY` changed). */
  | { state: "unreadable" };

export async function loadAppCredentials(): Promise<AppCredentialsResult> {
  try {
    const settings = await loadGitHubAppSettings(prisma);
    if (!settings) return { state: "not_configured" };
    return { state: "ok", app: { auth: { appId: settings.appId, privateKey: settings.privateKey }, slug: settings.slug } };
  } catch (error) {
    if (error instanceof GitHubAppKeyUnreadableError) return { state: "unreadable" };
    throw error;
  }
}

export type AppRepoStatus =
  | { state: "not_configured" }
  | { state: "not_installed"; installUrl: string }
  | { state: "installed"; installationId: number; accountLogin: string }
  /** GitHub did not answer, or the App credentials are broken: shown as a hint, never blocking the page. */
  | { state: "unknown"; message: string };

/**
 * Whether the App is installed on `owner/name`, for the project page banner (one request per page
 * render, memoized). For "not installed", the install link pre-selects the repository when the owner's
 * numeric account id can be resolved with the viewer's token.
 */
export const getAppRepoStatus = cache(
  async (owner: string, name: string, githubRepoId: number, accessToken?: string): Promise<AppRepoStatus> => {
    const credentials = await loadAppCredentials();
    if (credentials.state === "not_configured") return { state: "not_configured" };
    if (credentials.state === "unreadable") {
      return { state: "unknown", message: "The GitHub App key can't be read. Ask the administrator to re-enter it." };
    }
    const { app } = credentials;
    try {
      const installation = await getRepoInstallation(app.auth, owner, name, { fetch: timedFetch() });
      if (installation) return { state: "installed", ...installation };
    } catch (error) {
      if (error instanceof GitHubAppAuthError) return { state: "unknown", message: error.message };
      console.warn(`[dependencies] could not read the App installation of ${owner}/${name}`, error instanceof Error ? error.message : error);
      return { state: "unknown", message: "GitHub did not answer. Reload the page to check again." };
    }
    let targetId: number | undefined;
    try {
      const octokit = createOctokit({ accessToken, fetch: timedFetch(5_000) });
      targetId = (await octokit.rest.users.getByUsername({ username: owner })).data.id;
    } catch {
      targetId = undefined;
    }
    return { state: "not_installed", installUrl: installUrl(app.slug, githubRepoId, targetId) };
  },
);

export type RepoAccessCheck =
  | { ok: true; installationId: number }
  | { ok: false; code: ActionErrorCode; message: string };

/**
 * RepoPulse never takes the installation's word for who may use it (§3.8.4): the App must be
 * installed on the repository, and the user (by `githubLogin`, re-resolved from `githubId` on a 404)
 * must have at least `min` permission, checked with an installation token narrowed to the repository.
 */
export async function checkRepoAccess(
  user: Pick<DbUser, "id" | "githubId" | "githubLogin">,
  repo: { owner: string; name: string; githubRepoId: number },
  min: "read" | "write",
): Promise<RepoAccessCheck> {
  const fullName = `${repo.owner}/${repo.name}`;
  const credentials = await loadAppCredentials();
  if (credentials.state === "not_configured") {
    return { ok: false, code: "UNAVAILABLE", message: "The RepoPulse GitHub App is not set up. Ask the administrator to set it up first." };
  }
  if (credentials.state === "unreadable") {
    return { ok: false, code: "UNAVAILABLE", message: "The GitHub App key can't be read. Ask the administrator to re-enter it." };
  }
  const { auth } = credentials.app;
  const fetch = timedFetch();
  try {
    const installation = await getRepoInstallation(auth, repo.owner, repo.name, { fetch });
    if (!installation) return { ok: false, code: "CONFLICT", message: `Install the RepoPulse GitHub App on ${fullName} first.` };
    const { token } = await createInstallationToken(
      auth,
      installation.installationId,
      { repositoryIds: [repo.githubRepoId], permissions: { metadata: "read" } },
      { fetch },
    );
    const octokit = createOctokit({ accessToken: token, fetch });
    let permission = user.githubLogin ? await getCollaboratorPermission(octokit, repo.owner, repo.name, user.githubLogin) : null;
    if (!permissionAtLeast(permission, min)) {
      // Logins can change: re-resolve it from the immutable id and try once more.
      const login = await getUserLoginById(octokit, user.githubId);
      if (login && login !== user.githubLogin) {
        permission = await getCollaboratorPermission(octokit, repo.owner, repo.name, login);
        await prisma.user.update({ where: { id: user.id }, data: { githubLogin: login } }).catch(() => undefined);
      }
    }
    if (!permissionAtLeast(permission, min)) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message:
          min === "write"
            ? `Update pull requests need write access to ${fullName}, which your GitHub account doesn't have.`
            : `Your GitHub account can't read ${fullName}.`,
      };
    }
    return { ok: true, installationId: installation.installationId };
  } catch (error) {
    if (error instanceof GitHubAppAuthError || error instanceof GitHubAppInstallationError) {
      return { ok: false, code: "UNAVAILABLE", message: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Pull request plan (project page)
// ---------------------------------------------------------------------------

export interface PlannedPullRequest {
  groupKey: string;
  isMajor: boolean;
  updates: Array<{ name: string; manifestPath: string; from: string | null; to: string; level: SemverType | null }>;
  /** Lockfiles the update regenerates (in the sandbox). */
  lockfiles: string[];
  /** The PR currently recorded for this group, if any. */
  pullRequest: { number: number; htmlUrl: string; state: DepsPrState } | null;
  /** `null` = the button is enabled (write permission is still checked on click). */
  disabledReason: string | null;
}

export interface PlanPullRequestsInput {
  settings: Pick<DependencyProjectSettings, "updateMode" | "groupMode" | "maxOpenPrs">;
  prOwner: PrOwnerView;
  manifests: Array<Pick<DependencyManifestView, "id" | "path" | "ecosystem" | "packageManager" | "lockfilePath">>;
  updates: Array<
    Pick<DependencyUpdateView, "manifestId" | "manifestPath" | "ecosystem" | "name" | "currentVersion" | "targetVersion" | "level" | "status">
  >;
  pullRequests: Array<Pick<DependencyPullRequestView, "groupKey" | "number" | "htmlUrl" | "state">>;
}

/**
 * The planned update pull requests of a project: `groupUpdates` over its `OUTDATED` rows, each with
 * `groupCapability` (lockfile regeneration is available when the deps-worker heartbeat reports a reachable
 * sandbox, see `readLockfileRegenerationAvailable`) and
 * the reason "Create PR" is disabled, first match wins: notify mode, App missing / not installed, PRs
 * owned by another project, check-only package manager, an edited PR, no free slot.
 */
export function planPullRequests(
  project: PlanPullRequestsInput,
  app: AppRepoStatus,
  options: { lockfileRegeneration: boolean },
): PlannedPullRequest[] {
  const manifests = new Map(project.manifests.map((m) => [m.id, m]));
  const outdated = project.updates
    .filter((u) => u.status === "OUTDATED" && u.targetVersion)
    .map((u) => ({ ...u, manifestPath: u.manifestPath, level: u.level }));
  const groups = groupUpdates(outdated, project.settings.groupMode, project.settings.maxOpenPrs);
  return groups.map((group) => {
    const groupManifests = [...new Set(group.updates.map((u) => u.manifestId))].flatMap((id) => {
      const manifest = manifests.get(id);
      return manifest ? [{ path: manifest.path, packageManager: manifest.packageManager, lockfilePath: manifest.lockfilePath }] : [];
    });
    const capability = groupCapability(groupManifests, { lockfileRegeneration: options.lockfileRegeneration });
    const record = project.pullRequests.find((pr) => pr.groupKey === group.groupKey) ?? null;
    const open = record?.state === "OPEN";
    let disabledReason: string | null = null;
    if (project.settings.updateMode === "NOTIFY") disabledReason = "This project only notifies. Choose a pull request mode in Settings.";
    else if (app.state === "not_configured") disabledReason = "The administrator has not set up the RepoPulse GitHub App.";
    else if (app.state === "not_installed") disabledReason = "Install the RepoPulse GitHub App on this repository first.";
    else if (project.prOwner.kind === "other") disabledReason = `PRs are managed by another RepoPulse user (${project.prOwner.ownerName}).`;
    else if (project.prOwner.kind === "none") disabledReason = "Save a pull request mode in Settings to manage this repository's PRs.";
    else if (!capability.canCreatePr) disabledReason = capability.reason;
    else if (record?.state === "EDITED") disabledReason = "Someone else pushed to this pull request, so RepoPulse no longer updates it.";
    else if (!open && !group.hasPrSlot) disabledReason = `Waiting for a free slot (at most ${project.settings.maxOpenPrs} open pull requests).`;
    return {
      groupKey: group.groupKey,
      isMajor: group.isMajor,
      updates: group.updates.map((u) => ({ name: u.name, manifestPath: u.manifestPath, from: u.currentVersion, to: u.targetVersion!, level: u.level })),
      lockfiles: capability.lockfiles,
      pullRequest: record ? { number: record.number, htmlUrl: record.htmlUrl, state: record.state } : null,
      disabledReason,
    };
  });
}

/**
 * Planned update pull requests for a `/dependencies` list row, without making per-repository GitHub
 * API calls on list render (installation & write access are verified on click).
 */
export function planListPullRequests(
  project: DependencyProjectListItem,
  options: { appConfigured: boolean; lockfileRegeneration: boolean },
): PlannedPullRequest[] {
  if (project.updateMode === "NOTIFY") return [];
  const app: AppRepoStatus = options.appConfigured
    ? { state: "unknown", message: "" }
    : { state: "not_configured" };
  return planPullRequests(
    {
      settings: {
        updateMode: project.updateMode,
        groupMode: project.groupMode,
        maxOpenPrs: project.maxOpenPrs,
      },
      prOwner: project.prOwner,
      manifests: project.manifests,
      updates: project.outdatedUpdates,
      pullRequests: project.pullRequests,
    },
    app,
    { lockfileRegeneration: options.lockfileRegeneration },
  );
}
