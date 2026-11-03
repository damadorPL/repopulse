"use server";

import { revalidatePath } from "next/cache";
import { Queue } from "bullmq";
import { prisma, type DepsUpdateMode, type Prisma } from "@repopulse/db";
import {
  groupCapability,
  groupUpdates,
  ignorePatternMatches,
  ignoreRuleSchema,
  ignoreRulesSchema,
  isValidGroupKey,
  isValidRange,
  MAX_DEPENDENCY_PROJECTS_PER_USER,
  MAX_IGNORE_RULES,
  satisfiesRange,
  SCAN_COOLDOWN_MS,
  type DependencyEcosystem,
  type PackageManager,
  type RangeSyntax,
} from "@repopulse/deps";
import {
  createAppOctokit,
  createOctokit,
  getRepoInstallation,
  isGitHubHttpError,
  parseRepoInput,
  toRateLimitError,
} from "@repopulse/github";
import {
  DEPS_JOB_NAMES,
  DEPS_QUEUE_NAMES,
  DEPS_SCAN_JOB_OPTIONS,
  DEPS_SCAN_PRIORITY,
  DEPS_UPDATE_JOB_OPTIONS,
  DEPS_UPDATE_PRIORITY,
  depsScanJobId,
  depsUpdateJobId,
  type DepsScanJobData,
  type DepsScanTrigger,
  type DepsUpdateJobData,
} from "@repopulse/queue";
import { getCurrentUserOrThrow } from "@/lib/auth";
import {
  addDependencyProjectsInput,
  createPullRequestInput,
  dependencySettingsInput,
  ignoreDependencyInput,
  projectIdInput,
  readIgnoreRules,
  sameIgnoreRule,
  type AddDependencyProjectsInput,
  type DependencySettingsInput,
  type IgnoreDependencyInput,
  type IgnoreRuleValue,
} from "@/lib/dependency-settings";
import { normalizeWatchedPath } from "@/lib/watched-paths";
import { fail, getGitHubToken, invalidInput, isUniqueConstraintError, ok, toActionError, type ActionResult } from "@/server/action-result";
import { isDepsEnabled, readLockfileRegenerationAvailable } from "@/server/deps-status";
import { checkRepoAccess, loadAppCredentials, userDisplayName } from "@/server/queries/dependencies";
import { getRedis, isRealtimeConfigured, RealtimeUnavailableError, withRedisTimeout } from "@/server/realtime";

/**
 * Server Actions of the Dependencies module (Slice 08 §3.7). Every action is scoped to the signed-in
 * user's own projects (`{ id, userId }`), validates with `.strict()` zod schemas and returns
 * `ActionResult<T>`. Scans and update pull requests run in `deps-worker`; these only enqueue.
 */

const DISABLED_MESSAGE = "Dependency checks are turned off by the administrator.";

// ---------------------------------------------------------------------------
// Queue producers (deps-scan, deps-update)
// ---------------------------------------------------------------------------

const globalForDeps = globalThis as unknown as {
  repopulseDepsScanQueue?: Queue<DepsScanJobData>;
  repopulseDepsUpdateQueue?: Queue<DepsUpdateJobData>;
};

function getDepsScanQueue(): Queue<DepsScanJobData> {
  globalForDeps.repopulseDepsScanQueue ??= new Queue<DepsScanJobData>(DEPS_QUEUE_NAMES.scan, {
    connection: getRedis(),
    defaultJobOptions: DEPS_SCAN_JOB_OPTIONS,
  });
  return globalForDeps.repopulseDepsScanQueue;
}

function getDepsUpdateQueue(): Queue<DepsUpdateJobData> {
  globalForDeps.repopulseDepsUpdateQueue ??= new Queue<DepsUpdateJobData>(DEPS_QUEUE_NAMES.update, {
    connection: getRedis(),
    defaultJobOptions: DEPS_UPDATE_JOB_OPTIONS,
  });
  return globalForDeps.repopulseDepsUpdateQueue;
}

/**
 * Queues a priority `deps-scan`. The jobId deduplicates against a scan already queued (by the
 * scheduler): that job is taken over (data and priority) instead of being silently dropped.
 * Throws {@link RealtimeUnavailableError} when Redis is not configured or does not answer.
 */
async function enqueueScan(projectId: string, trigger: DepsScanTrigger, userId: string): Promise<void> {
  if (!isRealtimeConfigured()) throw new RealtimeUnavailableError("Background jobs are not configured (REDIS_URL is not set).");
  const queue = getDepsScanQueue();
  const jobId = depsScanJobId(projectId);
  const data: DepsScanJobData = { projectId, trigger, requestedByUserId: userId };
  const priority = DEPS_SCAN_PRIORITY[trigger];
  await withRedisTimeout(
    (async () => {
      const existing = await queue.getJob(jobId);
      if (!existing) {
        await queue.add(DEPS_JOB_NAMES.scan, data, { jobId, priority });
        return;
      }
      const state = await existing.getState();
      if (state === "waiting" || state === "prioritized" || state === "delayed") {
        await existing.updateData(data);
        if (state !== "delayed") await existing.changePriority({ priority });
      }
    })(),
  );
}

/** Best-effort re-check (ignore rules / policy changed): `true` when queued; the project shows "Re-checking…". */
async function queueRecheck(projectId: string, userId: string, caller: string): Promise<boolean> {
  try {
    await enqueueScan(projectId, "manual", userId);
    await prisma.dependencyProject.updateMany({ where: { id: projectId, userId, scanStatus: { not: "SCANNING" } }, data: { scanStatus: "QUEUED" } });
    return true;
  } catch (error) {
    console.warn(`[${caller}] could not queue a re-check of ${projectId}`, error instanceof Error ? error.message : error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Another project owns the PRs of this GitHub repository (one PR owner per repo, instance-wide). */
class PrOwnerConflictError extends Error {
  constructor(ownerName: string) {
    super(`Pull requests for this repository are already managed by ${ownerName} in RepoPulse. You can still use “Notify only”.`);
    this.name = "PrOwnerConflictError";
  }
}

/**
 * Claims `DependencyPrOwner` for `projectId` inside the transaction. Throws {@link PrOwnerConflictError}
 * when another project already owns the repository.
 */
async function claimPrOwnership(tx: Prisma.TransactionClient, projectId: string, githubRepoId: number): Promise<void> {
  const owner = await tx.dependencyPrOwner.findUnique({
    where: { githubRepoId },
    select: { projectId: true, project: { select: { user: { select: { githubLogin: true, name: true } } } } },
  });
  if (owner) {
    if (owner.projectId !== projectId) throw new PrOwnerConflictError(userDisplayName(owner.project.user));
    return;
  }
  await tx.dependencyPrOwner.create({ data: { githubRepoId, projectId } });
}

/** Range syntaxes an ignore rule's `versions` is tried in, for a row of this ecosystem / manager. */
function rangeSyntaxes(ecosystem: DependencyEcosystem, packageManager: PackageManager): RangeSyntax[] {
  if (ecosystem === "NPM") return ["npm"];
  return packageManager === "POETRY" ? ["poetry", "pep440"] : ["pep440", "poetry"];
}

function versionInRange(ecosystem: DependencyEcosystem, packageManager: PackageManager, version: string, range: string): boolean {
  return rangeSyntaxes(ecosystem, packageManager).some((syntax) => {
    try {
      return isValidRange(syntax, range) && satisfiesRange(syntax, version, range);
    } catch {
      return false;
    }
  });
}

interface StoredRow {
  id: string;
  name: string;
  targetVersion: string | null;
  latestVersion: string | null;
  manifest: { ecosystem: DependencyEcosystem; packageManager: PackageManager };
}

/**
 * Does a (new) ignore rule cover a stored row? Without `versions`, every row whose name matches. With
 * `versions`, only when the version the row is about (its target, else its latest version) is in range.
 */
function ruleCoversRow(rule: IgnoreRuleValue, row: StoredRow): boolean {
  if (!ignorePatternMatches(rule.name, row.name, row.manifest.ecosystem)) return false;
  if (!rule.versions) return true;
  const version = row.targetVersion ?? row.latestVersion;
  return version !== null && versionInRange(row.manifest.ecosystem, row.manifest.packageManager, version, rule.versions);
}

/**
 * Applies new ignore rules to the stored rows right away, without registry calls: covered rows become
 * `IGNORED` with no target, so the table and the sidebar count update at once. Returns how many changed.
 */
async function applyIgnoreRules(tx: Prisma.TransactionClient, projectId: string, rules: readonly IgnoreRuleValue[]): Promise<number> {
  if (rules.length === 0) return 0;
  const rows = await tx.dependencyUpdate.findMany({
    where: { projectId, status: { notIn: ["IGNORED", "UNSUPPORTED_SOURCE"] } },
    select: { id: true, name: true, targetVersion: true, latestVersion: true, manifest: { select: { ecosystem: true, packageManager: true } } },
  });
  const ids = rows.filter((row) => rules.some((rule) => ruleCoversRow(rule, row))).map((row) => row.id);
  if (ids.length === 0) return 0;
  const { count } = await tx.dependencyUpdate.updateMany({
    where: { projectId, id: { in: ids } },
    data: { status: "IGNORED", targetVersion: null },
  });
  return count;
}

function revalidateDependencies(): void {
  // The list, the project page, the repository card and the sidebar badge.
  revalidatePath("/", "layout");
}

function toDependencyActionError(error: unknown, action: string): ActionResult<never> {
  if (error instanceof PrOwnerConflictError) return fail("CONFLICT", error.message);
  if (error instanceof RealtimeUnavailableError) return fail("UNAVAILABLE", error.message);
  return toActionError(error, action);
}

// ---------------------------------------------------------------------------
// addDependencyProjectsAction
// ---------------------------------------------------------------------------

export interface AddDependencyProjectsResult {
  added: Array<{ projectId: string; fullName: string }>;
  /** Already projects of the user: reported, not duplicated. */
  existing: Array<{ projectId: string; fullName: string }>;
  /** Repositories that could not be added (not found, private without the App, …). */
  failed: Array<{ source: string; message: string }>;
  /** The first scans were queued (else the scheduler picks the projects up). */
  scansQueued: boolean;
}

interface RepoRefInput {
  label: string;
  owner: string;
  name: string;
}

interface FetchedRepo {
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

type FetchOutcome = { ok: true; repo: FetchedRepo } | { ok: false; message: string };

type RepoData = { id: number; name: string; full_name: string; default_branch: string; private: boolean; owner: { login: string } };

function toFetchedRepo(data: RepoData): FetchedRepo {
  return {
    githubRepoId: data.id,
    owner: data.owner.login,
    name: data.name,
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    isPrivate: data.private,
  };
}

const GITHUB_FETCH_TIMEOUT_MS = 10_000;
const timedFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) });

/**
 * Reads the repository with the user's token. The sign-in token can't read private repositories, so a
 * 404 falls back to the GitHub App: when it is installed on the repository, a metadata-only
 * installation token narrowed to it reads the repository. Rate limits are re-thrown (→ `RATE_LIMITED`).
 */
async function fetchRepository(ref: RepoRefInput, userToken: string | undefined): Promise<FetchOutcome> {
  const notFound = `${ref.owner}/${ref.name} was not found. For a private repository, install the RepoPulse GitHub App on it first.`;
  try {
    const octokit = createOctokit({ accessToken: userToken, fetch: timedFetch });
    const { data } = await octokit.rest.repos.get({ owner: ref.owner, repo: ref.name });
    return { ok: true, repo: toFetchedRepo(data) };
  } catch (error) {
    const rateLimited = toRateLimitError(error);
    if (rateLimited) throw rateLimited;
    if (!isGitHubHttpError(error) || (error.status !== 404 && error.status !== 403)) {
      console.warn(`[addDependencyProjectsAction] could not read ${ref.owner}/${ref.name}`, error instanceof Error ? error.message : error);
      return { ok: false, message: `GitHub did not answer for ${ref.owner}/${ref.name}. Try again.` };
    }
  }
  const credentials = await loadAppCredentials();
  if (credentials.state !== "ok") return { ok: false, message: notFound };
  try {
    const appOctokit = createAppOctokit(credentials.app.auth, { fetch: timedFetch });
    const installation = await getRepoInstallation(credentials.app.auth, ref.owner, ref.name, { octokit: appOctokit });
    if (!installation) return { ok: false, message: notFound };
    const token = await appOctokit.request("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: installation.installationId,
      repositories: [ref.name],
      permissions: { metadata: "read" },
    });
    const octokit = createOctokit({ accessToken: token.data.token, fetch: timedFetch });
    const { data } = await octokit.rest.repos.get({ owner: ref.owner, repo: ref.name });
    return { ok: true, repo: toFetchedRepo(data) };
  } catch (error) {
    const rateLimited = toRateLimitError(error);
    if (rateLimited) throw rateLimited;
    console.warn(`[addDependencyProjectsAction] App read of ${ref.owner}/${ref.name} failed`, error instanceof Error ? error.message : error);
    return { ok: false, message: notFound };
  }
}

/**
 * Adds repositories as dependency projects (1–20 sources: the user's subscriptions or any
 * `owner/name` / URL). Repositories are read from GitHub before the transaction. A private repository
 * needs the GitHub App installed and the user's read permission. Pull request modes are offered for a
 * single repository and claim the PR ownership. The first scans are queued right away (`trigger: "add"`).
 */
export async function addDependencyProjectsAction(input: AddDependencyProjectsInput): Promise<ActionResult<AddDependencyProjectsResult>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = addDependencyProjectsInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { sources, updateMode, notifyOnFirstScan } = parsed.data;
    if (!(await isDepsEnabled())) return fail("UNAVAILABLE", DISABLED_MESSAGE);
    if (updateMode !== "NOTIFY" && sources.length > 1) {
      return fail("INVALID_INPUT", "Pull request modes can be chosen when adding one repository. Add several with “Notify only”.");
    }

    // Subscriptions must be the user's own.
    const subscriptionIds = [...new Set(sources.flatMap((s) => ("subscriptionId" in s ? [s.subscriptionId] : [])))];
    const subscriptions =
      subscriptionIds.length > 0
        ? await prisma.userSubscription.findMany({
            where: { id: { in: subscriptionIds }, userId: user.id },
            select: { id: true, repository: { select: { owner: true, name: true, fullName: true } } },
          })
        : [];
    if (subscriptions.length !== subscriptionIds.length) return fail("NOT_FOUND", "Subscription not found.");
    const bySubscription = new Map(subscriptions.map((s) => [s.id, s.repository]));

    const refs: RepoRefInput[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      let ref: RepoRefInput;
      if ("subscriptionId" in source) {
        const repo = bySubscription.get(source.subscriptionId)!;
        ref = { label: repo.fullName, owner: repo.owner, name: repo.name };
      } else {
        const { owner, name } = parseRepoInput(source.repoUrlOrSlug);
        ref = { label: `${owner}/${name}`, owner, name };
      }
      const key = `${ref.owner}/${ref.name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }

    // GitHub before the transaction, so no DB connection is held during network I/O.
    const token = getGitHubToken(user, "addDependencyProjectsAction");
    const failed: AddDependencyProjectsResult["failed"] = [];
    const fetched: FetchedRepo[] = [];
    for (const ref of refs) {
      const outcome = await fetchRepository(ref, token);
      if (!outcome.ok) {
        failed.push({ source: ref.label, message: outcome.message });
        continue;
      }
      if (outcome.repo.isPrivate) {
        const access = await checkRepoAccess(user, outcome.repo, "read");
        if (!access.ok) {
          failed.push({ source: outcome.repo.fullName, message: `${outcome.repo.fullName} is private: ${access.message}` });
          continue;
        }
      }
      if (!fetched.some((repo) => repo.githubRepoId === outcome.repo.githubRepoId)) fetched.push(outcome.repo);
    }

    if (updateMode !== "NOTIFY" && fetched.length === 1) {
      const access = await checkRepoAccess(user, fetched[0]!, "write");
      if (!access.ok) return fail(access.code, access.message);
    }

    const githubRepoIds = fetched.map((repo) => repo.githubRepoId);
    const existingProjects = await prisma.dependencyProject.findMany({
      where: { userId: user.id, githubRepoId: { in: githubRepoIds } },
      select: { id: true, fullName: true, githubRepoId: true },
    });
    const existingIds = new Set(existingProjects.map((p) => p.githubRepoId));
    const toCreate = fetched.filter((repo) => !existingIds.has(repo.githubRepoId));
    const repositories =
      toCreate.length > 0
        ? await prisma.repository.findMany({
            where: { githubRepoId: { in: toCreate.map((repo) => repo.githubRepoId) } },
            select: { id: true, githubRepoId: true },
          })
        : [];
    const repositoryIdByGithubId = new Map(repositories.map((r) => [r.githubRepoId, r.id]));

    let added: AddDependencyProjectsResult["added"] = [];
    if (toCreate.length > 0) {
      const now = new Date();
      const result = await prisma.$transaction(async (tx) => {
        const count = await tx.dependencyProject.count({ where: { userId: user.id } });
        if (count + toCreate.length > MAX_DEPENDENCY_PROJECTS_PER_USER) {
          return {
            limit: true as const,
            count,
          };
        }
        const created: AddDependencyProjectsResult["added"] = [];
        for (const repo of toCreate) {
          const project = await tx.dependencyProject.create({
            data: {
              userId: user.id,
              githubRepoId: repo.githubRepoId,
              owner: repo.owner,
              name: repo.name,
              fullName: repo.fullName,
              defaultBranch: repo.defaultBranch,
              isPrivate: repo.isPrivate,
              repositoryId: repositoryIdByGithubId.get(repo.githubRepoId) ?? null,
              updateMode,
              notifyOnFirstScan,
              scanStatus: "QUEUED",
              nextScanAt: now,
            },
            select: { id: true, fullName: true },
          });
          if (updateMode !== "NOTIFY") await claimPrOwnership(tx, project.id, repo.githubRepoId);
          created.push({ projectId: project.id, fullName: project.fullName });
        }
        return { limit: false as const, created };
      });
      if (result.limit) {
        return fail(
          "CONFLICT",
          `You can check at most ${MAX_DEPENDENCY_PROJECTS_PER_USER} repositories (you have ${result.count}). Remove some projects first.`,
        );
      }
      added = result.created;
    }

    // After the commit, so the worker never runs against a project that is not there yet.
    let scansQueued = added.length > 0;
    for (const project of added) {
      try {
        await enqueueScan(project.projectId, "add", user.id);
      } catch (error) {
        scansQueued = false;
        console.warn(`[addDependencyProjectsAction] could not queue the first scan of ${project.projectId}`, error instanceof Error ? error.message : error);
        // `nextScanAt = now`: the scheduler picks it up on its next run.
        await prisma.dependencyProject.updateMany({ where: { id: project.projectId, userId: user.id, scanStatus: "QUEUED" }, data: { scanStatus: "IDLE" } });
      }
    }

    if (added.length > 0) revalidateDependencies();
    return ok({
      added,
      existing: existingProjects.map((p) => ({ projectId: p.id, fullName: p.fullName })),
      failed,
      scansQueued,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return fail("CONFLICT", "This repository was just added. Reload the page.");
    return toDependencyActionError(error, "addDependencyProjectsAction");
  }
}

// ---------------------------------------------------------------------------
// removeDependencyProjectAction
// ---------------------------------------------------------------------------

/**
 * Removes a project with its manifests, updates and PR records. The PR ownership is released by the
 * cascade; open pull requests stay on GitHub.
 */
export async function removeDependencyProjectAction(input: { projectId: string }): Promise<ActionResult<{ projectId: string }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = projectIdInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { count } = await prisma.dependencyProject.deleteMany({ where: { id: parsed.data.projectId, userId: user.id } });
    if (count === 0) return fail("NOT_FOUND", "Project not found.");
    revalidateDependencies();
    return ok({ projectId: parsed.data.projectId });
  } catch (error) {
    return toDependencyActionError(error, "removeDependencyProjectAction");
  }
}

// ---------------------------------------------------------------------------
// updateDependencyProjectSettingsAction
// ---------------------------------------------------------------------------

export interface DependencySettingsResult {
  projectId: string;
  updateMode: DepsUpdateMode;
  ignoreRules: IgnoreRuleValue[];
  manifestPaths: string[];
  /** Rows covered by newly added ignore rules (now `IGNORED`). */
  ignored: number;
  /** A re-check was queued because the policy changed (the table updates when it finishes). */
  rescanQueued: boolean;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Saves the project settings; only the fields sent change. Switching to a PR mode checks the App
 * installation and the user's write permission, then claims `DependencyPrOwner` in the transaction
 * (`CONFLICT` naming the owner when another project has it). Switching to `NOTIFY` releases it.
 * New ignore rules apply to stored rows at once; policy changes (and removed rules) queue a re-check.
 */
export async function updateDependencyProjectSettingsAction(input: DependencySettingsInput): Promise<ActionResult<DependencySettingsResult>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = dependencySettingsInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { projectId, ignoreRules: rawRules, manifestPaths: rawPaths, ...fields } = parsed.data;

    let ignoreRules: IgnoreRuleValue[] | undefined;
    if (rawRules !== undefined) {
      const rules = ignoreRulesSchema.safeParse(rawRules);
      if (!rules.success) return invalidInput(rules.error);
      ignoreRules = rules.data.reduce<IgnoreRuleValue[]>(
        (list, rule) => (list.some((r) => sameIgnoreRule(r, rule)) ? list : [...list, rule.versions ? { name: rule.name, versions: rule.versions } : { name: rule.name }]),
        [],
      );
    }
    let manifestPaths: string[] | undefined;
    if (rawPaths !== undefined) {
      manifestPaths = [];
      for (const raw of rawPaths) {
        if (raw.trim() === "") continue;
        const path = normalizeWatchedPath(raw);
        if (!path) return fail("INVALID_INPUT", `"${raw.slice(0, 60)}" is not a valid path. Use a path relative to the repository root.`);
        if (!manifestPaths.includes(path)) manifestPaths.push(path);
      }
    }

    const project = await prisma.dependencyProject.findFirst({
      where: { id: projectId, userId: user.id },
      select: {
        id: true,
        owner: true,
        name: true,
        githubRepoId: true,
        updateMode: true,
        maxUpdateLevel: true,
        includePrereleases: true,
        minReleaseAgeDays: true,
        rangeStrategy: true,
        ignoreRules: true,
        manifestPaths: true,
        lastScannedAt: true,
        prOwnership: { select: { projectId: true } },
      },
    });
    if (!project) return fail("NOT_FOUND", "Project not found.");

    const updateMode = fields.updateMode ?? project.updateMode;
    if (fields.updateMode && fields.updateMode !== "NOTIFY" && !project.prOwnership) {
      const access = await checkRepoAccess(user, project, "write");
      if (!access.ok) return fail(access.code, access.message);
    }

    const storedRules = readIgnoreRules(project.ignoreRules);
    const addedRules = ignoreRules?.filter((rule) => !storedRules.some((r) => sameIgnoreRule(r, rule))) ?? [];
    const removedRules = ignoreRules ? storedRules.filter((rule) => !ignoreRules.some((r) => sameIgnoreRule(r, rule))) : [];
    const policyChanged =
      (fields.maxUpdateLevel !== undefined && fields.maxUpdateLevel !== project.maxUpdateLevel) ||
      (fields.includePrereleases !== undefined && fields.includePrereleases !== project.includePrereleases) ||
      (fields.minReleaseAgeDays !== undefined && fields.minReleaseAgeDays !== project.minReleaseAgeDays) ||
      (fields.rangeStrategy !== undefined && fields.rangeStrategy !== project.rangeStrategy) ||
      (manifestPaths !== undefined && !sameStrings(manifestPaths, project.manifestPaths)) ||
      removedRules.length > 0 ||
      addedRules.some((rule) => rule.versions);

    const ignored = await prisma.$transaction(async (tx) => {
      if (fields.updateMode !== undefined) {
        if (fields.updateMode === "NOTIFY") await tx.dependencyPrOwner.deleteMany({ where: { projectId: project.id } });
        else await claimPrOwnership(tx, project.id, project.githubRepoId);
      }
      const nextScanAt =
        fields.scanIntervalHours !== undefined
          ? new Date((project.lastScannedAt ?? new Date()).getTime() + fields.scanIntervalHours * 60 * 60 * 1000)
          : undefined;
      await tx.dependencyProject.update({
        where: { id: project.id },
        data: {
          ...fields,
          ...(ignoreRules !== undefined ? { ignoreRules } : {}),
          ...(manifestPaths !== undefined ? { manifestPaths } : {}),
          ...(nextScanAt ? { nextScanAt } : {}),
        },
      });
      return applyIgnoreRules(tx, project.id, addedRules);
    });

    const rescanQueued = policyChanged ? await queueRecheck(project.id, user.id, "updateDependencyProjectSettingsAction") : false;
    revalidateDependencies();
    return ok({
      projectId: project.id,
      updateMode,
      ignoreRules: ignoreRules ?? storedRules,
      manifestPaths: manifestPaths ?? project.manifestPaths,
      ignored,
      rescanQueued,
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return fail("CONFLICT", "Pull requests for this repository were just claimed by another project. Reload the page.");
    return toDependencyActionError(error, "updateDependencyProjectSettingsAction");
  }
}

// ---------------------------------------------------------------------------
// triggerDependencyScanAction
// ---------------------------------------------------------------------------

export type DependencyScanResult =
  | { status: "QUEUED"; fullName: string }
  | { status: "COOLDOWN"; fullName: string; retryAfterSeconds: number };

/** "Check now": a priority scan, at most once every 5 minutes per project (on `lastScannedAt`). */
export async function triggerDependencyScanAction(input: { projectId: string }): Promise<ActionResult<DependencyScanResult>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = projectIdInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const project = await prisma.dependencyProject.findFirst({
      where: { id: parsed.data.projectId, userId: user.id },
      select: { id: true, fullName: true, lastScannedAt: true },
    });
    if (!project) return fail("NOT_FOUND", "Project not found.");
    if (!(await isDepsEnabled())) return fail("UNAVAILABLE", DISABLED_MESSAGE);

    const elapsed = project.lastScannedAt ? Date.now() - project.lastScannedAt.getTime() : Infinity;
    if (elapsed < SCAN_COOLDOWN_MS) {
      return ok({
        status: "COOLDOWN",
        fullName: project.fullName,
        retryAfterSeconds: Math.max(1, Math.ceil((SCAN_COOLDOWN_MS - elapsed) / 1000)),
      });
    }

    await enqueueScan(project.id, "manual", user.id);
    await prisma.dependencyProject.updateMany({
      where: { id: project.id, userId: user.id, scanStatus: { not: "SCANNING" } },
      data: { scanStatus: "QUEUED" },
    });
    revalidateDependencies();
    return ok({ status: "QUEUED", fullName: project.fullName });
  } catch (error) {
    return toDependencyActionError(error, "triggerDependencyScanAction");
  }
}

// ---------------------------------------------------------------------------
// createDependencyPullRequestAction
// ---------------------------------------------------------------------------

/**
 * "Create PR" / "Update PR" for one planned group. Re-checks everything the button showed: the mode
 * is not `NOTIFY`, this project owns the repository's PRs, the group exists and has a slot, its
 * manifests support update PRs, the App is installed and the user has write permission. Then
 * enqueues `deps-update` (priority 1); the outcome arrives as `DEPS_PULL_REQUEST_UPDATED`.
 */
export async function createDependencyPullRequestAction(input: {
  projectId: string;
  groupKey: string;
}): Promise<ActionResult<{ status: "QUEUED"; groupKey: string }>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = createPullRequestInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { projectId, groupKey } = parsed.data;
    if (!isValidGroupKey(groupKey)) return fail("INVALID_INPUT", "Unknown pull request group.");

    const project = await prisma.dependencyProject.findFirst({
      where: { id: projectId, userId: user.id },
      select: {
        id: true,
        owner: true,
        name: true,
        githubRepoId: true,
        updateMode: true,
        groupMode: true,
        maxOpenPrs: true,
        prOwnership: { select: { projectId: true } },
        pullRequests: { where: { state: "OPEN" }, select: { groupKey: true } },
        updates: {
          where: { status: "OUTDATED" },
          select: {
            name: true,
            level: true,
            manifest: { select: { path: true, ecosystem: true, packageManager: true, lockfilePath: true } },
          },
        },
      },
    });
    if (!project) return fail("NOT_FOUND", "Project not found.");
    if (!(await isDepsEnabled())) return fail("UNAVAILABLE", DISABLED_MESSAGE);
    if (project.updateMode === "NOTIFY") {
      return fail("CONFLICT", "This project only notifies. Choose a pull request mode in its settings first.");
    }
    if (!project.prOwnership) {
      const owner = await prisma.dependencyPrOwner.findUnique({
        where: { githubRepoId: project.githubRepoId },
        select: { project: { select: { user: { select: { githubLogin: true, name: true } } } } },
      });
      return fail(
        "CONFLICT",
        owner
          ? new PrOwnerConflictError(userDisplayName(owner.project.user)).message
          : "This project doesn't manage pull requests for the repository. Save a pull request mode again in its settings.",
      );
    }

    const groups = groupUpdates(
      project.updates.map((u) => ({ ecosystem: u.manifest.ecosystem, name: u.name, manifestPath: u.manifest.path, level: u.level, manifest: u.manifest })),
      project.groupMode,
      project.maxOpenPrs,
    );
    const group = groups.find((g) => g.groupKey === groupKey);
    if (!group) return fail("NOT_FOUND", "Nothing to update in this group any more. Check the project again.");
    const hasOpenPr = project.pullRequests.some((pr) => pr.groupKey === groupKey);
    if (!hasOpenPr && !group.hasPrSlot) {
      return fail("CONFLICT", `All ${project.maxOpenPrs} pull request slots are taken. Merge or close one, or raise the limit.`);
    }
    const manifests = [...new Map(group.updates.map((u) => [u.manifest.path, u.manifest])).values()];
    const capability = groupCapability(
      manifests.map((m) => ({ path: m.path, packageManager: m.packageManager, lockfilePath: m.lockfilePath })),
      // The worker refuses lockfile groups while the sandbox is unreachable: say so now instead of queueing.
      { lockfileRegeneration: await readLockfileRegenerationAvailable() },
    );
    if (!capability.canCreatePr) return fail("CONFLICT", capability.reason ?? "This group can't get a pull request.");

    const access = await checkRepoAccess(user, project, "write");
    if (!access.ok) return fail(access.code, access.message);

    if (!isRealtimeConfigured()) throw new RealtimeUnavailableError("Background jobs are not configured (REDIS_URL is not set).");
    const queue = getDepsUpdateQueue();
    const jobId = depsUpdateJobId(project.id, groupKey);
    await withRedisTimeout(
      (async () => {
        const existing = await queue.getJob(jobId);
        if (!existing) {
          await queue.add(DEPS_JOB_NAMES.update, { projectId: project.id, groupKey, trigger: "manual" }, { jobId, priority: DEPS_UPDATE_PRIORITY.manual });
          return;
        }
        const state = await existing.getState();
        if (state === "waiting" || state === "prioritized") await existing.changePriority({ priority: DEPS_UPDATE_PRIORITY.manual });
      })(),
    );
    return ok({ status: "QUEUED", groupKey });
  } catch (error) {
    return toDependencyActionError(error, "createDependencyPullRequestAction");
  }
}

// ---------------------------------------------------------------------------
// Ignore rules
// ---------------------------------------------------------------------------

export interface IgnoreRulesResult {
  ignoreRules: IgnoreRuleValue[];
  /** Rows that became `IGNORED`. */
  ignored: number;
  /** A re-check was queued (removed rules, version-range rules). */
  rescanQueued: boolean;
}

/**
 * "Ignore this version" / "Ignore dependency": adds an ignore rule and marks the stored rows it covers
 * `IGNORED` at once (no registry call). A version-range rule also queues a re-check, because an older
 * version outside the range may still be a valid target.
 */
export async function ignoreDependencyAction(input: IgnoreDependencyInput): Promise<ActionResult<IgnoreRulesResult>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = ignoreDependencyInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const ruleParsed = ignoreRuleSchema.safeParse({ name: parsed.data.name, versions: parsed.data.versions });
    if (!ruleParsed.success) return invalidInput(ruleParsed.error);
    const rule: IgnoreRuleValue = ruleParsed.data.versions ? { name: ruleParsed.data.name, versions: ruleParsed.data.versions } : { name: ruleParsed.data.name };

    const project = await prisma.dependencyProject.findFirst({
      where: { id: parsed.data.projectId, userId: user.id },
      select: { id: true, ignoreRules: true },
    });
    if (!project) return fail("NOT_FOUND", "Project not found.");
    const rules = readIgnoreRules(project.ignoreRules);
    if (rules.some((r) => sameIgnoreRule(r, rule))) return ok({ ignoreRules: rules, ignored: 0, rescanQueued: false });
    if (rules.length >= MAX_IGNORE_RULES) return fail("INVALID_INPUT", `A project can have at most ${MAX_IGNORE_RULES} ignore rules.`);
    const next = [...rules, rule];

    const ignored = await prisma.$transaction(async (tx) => {
      await tx.dependencyProject.update({ where: { id: project.id }, data: { ignoreRules: next } });
      return applyIgnoreRules(tx, project.id, [rule]);
    });
    const rescanQueued = rule.versions ? await queueRecheck(project.id, user.id, "ignoreDependencyAction") : false;
    revalidateDependencies();
    return ok({ ignoreRules: next, ignored, rescanQueued });
  } catch (error) {
    return toDependencyActionError(error, "ignoreDependencyAction");
  }
}

/**
 * Removes an ignore rule. Un-ignoring can't be computed without registry data, so it queues a re-check
 * (bypassing the "Check now" cooldown) and the page shows "Re-checking…".
 */
export async function removeIgnoreRuleAction(input: IgnoreDependencyInput): Promise<ActionResult<IgnoreRulesResult>> {
  try {
    const user = await getCurrentUserOrThrow();
    const parsed = ignoreDependencyInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const project = await prisma.dependencyProject.findFirst({
      where: { id: parsed.data.projectId, userId: user.id },
      select: { id: true, ignoreRules: true },
    });
    if (!project) return fail("NOT_FOUND", "Project not found.");
    const rules = readIgnoreRules(project.ignoreRules);
    const target: IgnoreRuleValue = { name: parsed.data.name, versions: parsed.data.versions };
    const next = rules.filter((rule) => !sameIgnoreRule(rule, target));
    if (next.length === rules.length) return fail("NOT_FOUND", "Ignore rule not found.");

    await prisma.dependencyProject.update({ where: { id: project.id }, data: { ignoreRules: next } });
    const rescanQueued = await queueRecheck(project.id, user.id, "removeIgnoreRuleAction");
    revalidateDependencies();
    return ok({ ignoreRules: next, ignored: 0, rescanQueued });
  } catch (error) {
    return toDependencyActionError(error, "removeIgnoreRuleAction");
  }
}
