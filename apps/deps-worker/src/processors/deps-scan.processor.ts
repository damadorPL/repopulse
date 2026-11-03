import { Worker, type Job, type Queue } from "bullmq";
import { loadDepsEnabled, type PrismaClient } from "@repopulse/db";
import {
  formatTarget,
  groupCapability,
  groupUpdates,
  isRegistryUnavailableError,
  MAX_DEPENDENCIES_PER_PROJECT,
  parseTarget,
  type DependencyEcosystem,
  type PackageManager,
  type SemverType,
} from "@repopulse/deps";
import { GitHubRateLimitError, GitHubRepositoryNotFoundError, isGitHubHttpError, type GitTreeSnapshot } from "@repopulse/github";
import {
  DEPS_JOB_NAMES,
  DEPS_UPDATE_PRIORITY,
  depsUpdateJobId,
  type DepsNotifyJobData,
  type DepsScanJobData,
  type DepsUpdateJobData,
  type Redis,
} from "@repopulse/queue";
import {
  analyzeProject,
  capDependencies,
  createSnapshotReader,
  lookupRegistries,
  planAnalysis,
  rowKey,
  type PlannedDependency,
  type RegistryLookupFn,
} from "../analysis";
import { PRIVATE_WITHOUT_APP_MESSAGE, type GitHubAccess, type ReadCandidate } from "../github-access";
import { defaultGitHubApi, type GitHubApi, type Octokit } from "../github-api";
import { createLogger } from "../logger";
import type { BlobCache, LockfileCache } from "../registry-cache";
import { rateLimitDelayMs } from "../rate-limit";
import { flushNotificationOutbox, storeNotificationIntents } from "../notification-outbox";
import {
  digestScanId,
  notifyPullRequestEvent,
  passesDependencyNotificationLevel,
  publish,
  rulesFor,
  type NotifyQueue,
} from "./notify-jobs";
import { ownerHasPermission, revokePullRequestMode } from "./repo-access";

const log = createLogger("deps-scan");

/** Consecutive failures after which a project is paused (like repository polling). */
export const MAX_ERROR_COUNT = 5;
/** A paused project is retried this long after its last failure ("Check now" works at any time). */
export const PAUSED_RESCAN_MS = 7 * 24 * 3600_000;
/** Transient failures (registry down, network) are retried after at most this long. */
export const FAILED_RESCAN_MAX_MS = 6 * 3600_000;
/** Interactive transactions of a large project (1,000 rows) need more than Prisma's 5 s default. */
const TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 10_000 };

/** A private repository read with the App token whose owner no longer has read permission (§3.8.4). */
export const NO_ACCESS_MESSAGE = "You no longer have access to this private repository";

export const SCAN_FAILED_MESSAGE = "The dependency check failed. It will be retried on the next scheduled check.";

export interface DepsScanDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, "publish">;
  scanQueue: Pick<Queue<DepsScanJobData>, "rateLimit">;
  updateQueue: Pick<Queue<DepsUpdateJobData>, "addBulk" | "getJob">;
  notifyQueue: NotifyQueue;
  access: Pick<GitHubAccess, "readAccess" | "invalidate">;
  github?: Pick<
    GitHubApi,
    "createOctokit" | "fetchGitTree" | "readBlobs" | "getPullRequestState" | "getCollaboratorPermission" | "getUserLoginById"
  >;
  registry: RegistryLookupFn;
  blobCache?: BlobCache | null;
  lockCache?: LockfileCache | null;
  /** `true` when the sandbox is configured (`DEPS_SANDBOX_TOKEN`): groups that need a lockfile may get PRs. */
  lockfileRegeneration: boolean;
  now?: () => Date;
}

export type DepsScanOutcome =
  | { status: "SKIPPED"; reason: "DISABLED" | "PROJECT_GONE" }
  | { status: "PRIVATE_WITHOUT_APP" }
  | { status: "NO_ACCESS"; switchedToNotify: boolean }
  | { status: "NOT_FOUND"; errorCount: number }
  | {
      status: "SCANNED";
      manifests: number;
      dependencies: number;
      outdated: number;
      majors: number;
      digests: number;
      autoUpdates: number;
      pullRequests: { merged: number; closed: number; edited: number };
    };

type ProjectRow = NonNullable<Awaited<ReturnType<PrismaClient["dependencyProject"]["findUnique"]>>>;

function notFoundMessage(fullName: string): string {
  return `${fullName} was not found on GitHub. It may have been renamed, deleted or made private (install the GitHub App to check private repositories).`;
}

function registryMessage(error: { registry: "npm" | "pypi" }): string {
  return `${error.registry === "npm" ? "The npm registry" : "PyPI"} is not responding. The check will be retried.`;
}

/** Reads the tree with each candidate in turn, moving on only when GitHub rejects a token (401). */
async function fetchWithFallback(
  deps: DepsScanDeps,
  github: NonNullable<DepsScanDeps["github"]>,
  project: ProjectRow,
  candidates: ReadCandidate[],
  installationId: number | null,
  signal: AbortSignal | undefined,
): Promise<{ snapshot: GitTreeSnapshot; candidate: ReadCandidate; octokit: Octokit }> {
  for (const [index, candidate] of candidates.entries()) {
    const octokit = github.createOctokit({ accessToken: candidate.token });
    try {
      const snapshot = await github.fetchGitTree({
        owner: project.owner,
        name: project.name,
        repositoryId: project.githubRepoId,
        octokit,
        ...(signal ? { signal } : {}),
      });
      return { snapshot, candidate, octokit };
    } catch (error) {
      if (isGitHubHttpError(error) && error.status === 401) {
        if (candidate.source === "app" && installationId !== null) deps.access.invalidate(installationId);
        if (index < candidates.length - 1) {
          log.warn(`${project.fullName}: ${candidate.source} token was rejected (401); trying the next one`);
          continue;
        }
      }
      throw error;
    }
  }
  throw new Error("no read credentials");
}

interface RowData {
  declared: string;
  currentVersion: string | null;
  wantedVersion: string | null;
  targetVersion: string | null;
  latestVersion: string | null;
  level: SemverType | null;
  status: Exclude<PlannedDependency["selection"]["status"], "UP_TO_DATE">;
  targetReleasedAt: Date | null;
  sourceRepoUrl: string | null;
}

function rowData(planned: PlannedDependency): RowData | null {
  const { selection, dependency } = planned;
  if (selection.status === "UP_TO_DATE") return null;
  return {
    declared: dependency.declared,
    currentVersion: planned.currentVersion,
    wantedVersion: selection.wantedVersion,
    targetVersion: selection.targetVersion,
    latestVersion: selection.latestVersion,
    level: selection.level,
    status: selection.status,
    targetReleasedAt: selection.targetReleasedAt,
    sourceRepoUrl: selection.status === "UNSUPPORTED_SOURCE" ? null : planned.sourceRepoUrl,
  };
}

function sameDate(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function rowChanged(existing: RowData & { firstSeenAt: Date; notifiedAt: Date | null }, next: RowData): boolean {
  return (
    existing.declared !== next.declared ||
    existing.currentVersion !== next.currentVersion ||
    existing.wantedVersion !== next.wantedVersion ||
    existing.targetVersion !== next.targetVersion ||
    existing.latestVersion !== next.latestVersion ||
    existing.level !== next.level ||
    existing.status !== next.status ||
    !sameDate(existing.targetReleasedAt, next.targetReleasedAt) ||
    existing.sourceRepoUrl !== next.sourceRepoUrl
  );
}

/**
 * `deps-scan` job (Slice 08 §3.6): read the default-branch tree with the best read credentials, detect and parse
 * the manifests, look up the registries, plan, persist in one transaction, refresh the open PRs, then SSE, digest
 * notifications and (AUTO_PR) update jobs.
 */
export async function processDepsScan(job: Job<DepsScanJobData>, deps: DepsScanDeps, signal?: AbortSignal): Promise<DepsScanOutcome> {
  const { prisma } = deps;
  const github = deps.github ?? defaultGitHubApi;
  const now = () => deps.now?.() ?? new Date();
  const { projectId, trigger } = job.data;

  if (!(await loadDepsEnabled(prisma))) {
    log.info(`project ${projectId}: dependency checks are disabled; scan skipped`);
    return { status: "SKIPPED", reason: "DISABLED" };
  }
  const project = await prisma.dependencyProject.findUnique({ where: { id: projectId } });
  if (!project) return { status: "SKIPPED", reason: "PROJECT_GONE" };
  const user = await prisma.user.findUnique({ where: { id: project.userId }, select: { id: true, githubId: true, githubLogin: true, githubAccessTokenEncrypted: true } });
  if (!user) return { status: "SKIPPED", reason: "PROJECT_GONE" };

  const requester = job.data.requestedByUserId ?? (trigger === "manual" ? project.userId : undefined);
  const scanFailed = (message: string) =>
    requester
      ? publish(deps.redis, requester, { type: "DEPS_SCAN_FAILED", projectId, fullName: project.fullName, message })
      : Promise.resolve();
  const intervalMs = project.scanIntervalHours * 3600_000;

  /** Handled failure: user-safe `scanError`, `ERROR`, no BullMQ retry. */
  const recordHandled = async (message: string, countIt: boolean): Promise<number> => {
    const at = now();
    const { errorCount } = await prisma.dependencyProject.update({
      where: { id: projectId },
      data: {
        scanStatus: "ERROR",
        scanError: message,
        nextScanAt: new Date(at.getTime() + intervalMs),
        ...(countIt ? { errorCount: { increment: 1 } } : {}),
      },
      select: { errorCount: true },
    });
    if (countIt && errorCount >= MAX_ERROR_COUNT) {
      await prisma.dependencyProject.update({ where: { id: projectId }, data: { nextScanAt: new Date(at.getTime() + PAUSED_RESCAN_MS) } });
    }
    await scanFailed(message);
    return errorCount;
  };

  await prisma.dependencyProject.update({ where: { id: projectId }, data: { scanStatus: "SCANNING" } });
  const firstScan = project.lastScannedAt === null;

  try {
    // Step 1: read credentials.
    const access = await deps.access.readAccess(project, user);
    if (access.kind === "private-without-app") {
      log.warn(`${project.fullName}: private repository without the GitHub App`);
      await recordHandled(access.message, false);
      return { status: "PRIVATE_WITHOUT_APP" };
    }

    // Step 2: tree + metadata.
    const { snapshot, candidate, octokit } = await fetchWithFallback(deps, github, project, access.candidates, access.installationId, signal);
    if (snapshot.repository.id !== project.githubRepoId) throw new GitHubRepositoryNotFoundError(project.owner, project.name);
    if (snapshot.repository.isPrivate && candidate.source !== "app") {
      await prisma.dependencyProject.update({ where: { id: projectId }, data: { isPrivate: true } });
      await recordHandled(PRIVATE_WITHOUT_APP_MESSAGE, false);
      return { status: "PRIVATE_WITHOUT_APP" };
    }
    // Private repository read with the App token: the installation alone never grants access, so the owner's
    // read permission is checked on every scan. Without it nothing new is written and PR modes are revoked.
    if (snapshot.repository.isPrivate && !(await ownerHasPermission(prisma, github, octokit, snapshot.repository, user, "read"))) {
      const switchedToNotify = await revokePullRequestMode(deps, project, null, now());
      log.warn(`${project.fullName}: the owner has no read access to the private repository${switchedToNotify ? "; switched to notify-only" : ""}`);
      await recordHandled(NO_ACCESS_MESSAGE, false);
      return { status: "NO_ACCESS", switchedToNotify };
    }
    const repo = snapshot.repository;
    const reader = createSnapshotReader(
      snapshot.entries,
      (refs, maxBytes) => github.readBlobs(octokit, repo.owner, repo.name, refs, { maxBytes, ...(signal ? { signal } : {}) }),
      deps.blobCache,
    );
    const analysis = capDependencies(
      await analyzeProject({
        entries: snapshot.entries,
        manifestPaths: project.manifestPaths,
        reader,
        lockCache: deps.lockCache ?? null,
        truncated: snapshot.truncated,
      }),
      MAX_DEPENDENCIES_PER_PROJECT,
    );

    // Step 3: registries + policy.
    const [storedManifests, storedUpdates] = await Promise.all([
      prisma.dependencyManifest.findMany({ where: { projectId } }),
      prisma.dependencyUpdate.findMany({ where: { projectId } }),
    ]);
    const manifestPathById = new Map(storedManifests.map((m) => [m.id, m.path]));
    const dismissed = new Map<string, string>();
    for (const row of storedUpdates) {
      const path = manifestPathById.get(row.manifestId);
      if (row.status === "DISMISSED" && row.targetVersion && path) dismissed.set(rowKey(path, row.name, row.kind, row.group), row.targetVersion);
    }
    const lookups = await lookupRegistries(
      analysis.manifests.flatMap((m) => m.dependencies.filter((d) => d.dependency.supported).map((d) => ({ ecosystem: d.ecosystem, name: d.dependency.name }))),
      deps.registry,
      signal,
    );
    const scannedAt = now();
    const planned = planAnalysis(analysis.manifests, lookups, project, dismissed, scannedAt);

    // Step 4: persist in one transaction.
    const existingByKey = new Map(
      storedUpdates.flatMap((row) => {
        const path = manifestPathById.get(row.manifestId);
        return path ? [[rowKey(path, row.name, row.kind, row.group), row] as const] : [];
      }),
    );
    const detectedPaths = analysis.manifests.map((m) => m.detected.path);
    await prisma.$transaction(async (tx) => {
      await tx.dependencyManifest.deleteMany({ where: { projectId, path: { notIn: detectedPaths } } });
      const manifestIds = new Map<string, string>();
      for (const [index, manifest] of analysis.manifests.entries()) {
        const { detected } = manifest;
        // Project-level warnings (manifest / dependency caps) are shown with the first manifest.
        const warnings = index === 0 ? [...new Set([...analysis.warnings, ...manifest.warnings])] : manifest.warnings;
        const data = {
          ecosystem: detected.ecosystem,
          packageManager: detected.packageManager,
          lockfilePath: detected.lockfilePath,
          workspaceRoot: detected.workspaceRoot,
          blobSha: detected.blobSha ?? "",
          dependencyCount: manifest.dependencies.length,
          warnings,
        };
        const row = await tx.dependencyManifest.upsert({
          where: { projectId_path: { projectId, path: detected.path } },
          create: { projectId, path: detected.path, ...data },
          update: data,
          select: { id: true },
        });
        manifestIds.set(detected.path, row.id);
      }

      const keep = new Set<string>();
      const toCreate: Array<Record<string, unknown>> = [];
      for (const item of planned) {
        const data = rowData(item);
        if (!data) continue;
        const path = item.manifest.detected.path;
        const key = rowKey(path, item.dependency.name, item.dependency.kind, item.dependency.group);
        if (keep.has(key)) continue;
        keep.add(key);
        const existing = existingByKey.get(key);
        if (!existing) {
          toCreate.push({
            projectId,
            manifestId: manifestIds.get(path)!,
            name: item.dependency.name,
            kind: item.dependency.kind,
            group: item.dependency.group,
            ...data,
            firstSeenAt: scannedAt,
            notifiedAt: null,
          });
          continue;
        }
        const sameTarget = existing.targetVersion === data.targetVersion;
        if (!sameTarget || rowChanged(existing, data)) {
          await tx.dependencyUpdate.update({
            where: { id: existing.id },
            // Same target: keep firstSeenAt / notifiedAt. A new target is new news.
            data: { ...data, ...(sameTarget ? {} : { firstSeenAt: scannedAt, notifiedAt: null }) },
          });
        }
      }
      const stale = [...existingByKey].filter(([key]) => !keep.has(key)).map(([, row]) => row.id);
      if (stale.length > 0) await tx.dependencyUpdate.deleteMany({ where: { id: { in: stale } } });
      if (toCreate.length > 0) await tx.dependencyUpdate.createMany({ data: toCreate as never });

      await tx.dependencyProject.update({
        where: { id: projectId },
        data: {
          owner: repo.owner,
          name: repo.name,
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          isPrivate: repo.isPrivate,
          lastScannedAt: scannedAt,
          lastScannedSha: snapshot.commitSha,
          nextScanAt: new Date(scannedAt.getTime() + intervalMs),
          scanStatus: "IDLE",
          scanError: null,
          errorCount: 0,
        },
      });
    }, TRANSACTION_OPTIONS);
    const current = { ...project, owner: repo.owner, name: repo.name, fullName: repo.fullName, defaultBranch: repo.defaultBranch };

    // Step 5: refresh open pull requests.
    const prCounts = await refreshPullRequests(deps, github, octokit, current);

    // Step 6: SSE, digest, auto PRs.
    const outdatedRows = await prisma.dependencyUpdate.findMany({ where: { projectId, status: "OUTDATED" } });
    const majors = outdatedRows.filter((row) => row.level === "MAJOR").length;
    await publish(deps.redis, project.userId, {
      type: "DEPS_SCAN_COMPLETED",
      projectId,
      fullName: repo.fullName,
      outdated: outdatedRows.length,
      majors,
    });
    const digests = await queueDigest(deps, current, outdatedRows, firstScan, scannedAt);
    const autoUpdates =
      project.updateMode === "AUTO_PR" && access.installationId !== null ? await queueAutoUpdates(deps, current, outdatedRows) : 0;

    const dependencies = analysis.manifests.reduce((sum, m) => sum + m.dependencies.length, 0);
    log.info(
      `${repo.fullName}: ${analysis.manifests.length} manifests, ${dependencies} dependencies, ${outdatedRows.length} outdated ` +
        `(${majors} major), ${reader.downloaded} blobs downloaded via ${candidate.source}, ${digests} digest job(s), ${autoUpdates} update job(s)`,
    );
    return {
      status: "SCANNED",
      manifests: analysis.manifests.length,
      dependencies,
      outdated: outdatedRows.length,
      majors,
      digests,
      autoUpdates,
      pullRequests: prCounts,
    };
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      const delayMs = rateLimitDelayMs(error.resetAt, now());
      await prisma.dependencyProject.update({ where: { id: projectId }, data: { scanStatus: "QUEUED" } });
      await deps.scanQueue.rateLimit(delayMs);
      log.warn(`${project.fullName}: GitHub rate limit exceeded; pausing deps-scan for ${Math.ceil(delayMs / 1000)}s`);
      throw Worker.RateLimitError();
    }
    if (error instanceof GitHubRepositoryNotFoundError) {
      const errorCount = await recordHandled(notFoundMessage(project.fullName), true);
      log.warn(`${project.fullName}: not found (errorCount ${errorCount}/${MAX_ERROR_COUNT})`);
      return { status: "NOT_FOUND", errorCount };
    }

    // Registry 429 / 5xx, network, anything else: BullMQ retries; the previous results stay. Only the last attempt counts.
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const message = isRegistryUnavailableError(error) ? registryMessage(error) : SCAN_FAILED_MESSAGE;
    try {
      if (finalAttempt) {
        const at = now();
        const { errorCount } = await prisma.dependencyProject.update({
          where: { id: projectId },
          data: {
            scanStatus: "ERROR",
            scanError: message,
            errorCount: { increment: 1 },
            nextScanAt: new Date(at.getTime() + Math.min(intervalMs, FAILED_RESCAN_MAX_MS)),
          },
          select: { errorCount: true },
        });
        if (errorCount >= MAX_ERROR_COUNT) {
          await prisma.dependencyProject.update({ where: { id: projectId }, data: { nextScanAt: new Date(at.getTime() + PAUSED_RESCAN_MS) } });
        }
        await scanFailed(message);
      } else {
        await prisma.dependencyProject.update({ where: { id: projectId }, data: { scanStatus: "QUEUED" } });
      }
    } catch (recordError) {
      log.error(`${project.fullName}: could not record the failure`, recordError);
    }
    log.warn(
      `${project.fullName}: attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

type CurrentProject = ProjectRow;

/** Whether an update job for the group is waiting or running (its push must not be mistaken for a human edit). */
async function updateInFlight(deps: DepsScanDeps, projectId: string, groupKey: string): Promise<boolean> {
  try {
    const existing = await deps.updateQueue.getJob(depsUpdateJobId(projectId, groupKey));
    if (!existing) return false;
    const state = await existing.getState();
    return state !== "completed" && state !== "failed" && state !== "unknown";
  } catch {
    return true;
  }
}

/**
 * §3.6 step 5: merged → `MERGED`; closed → `CLOSED` and its targets' rows `DISMISSED`; open with a head the bot
 * did not push → `EDITED` (notified once, never touched again). Best effort per PR.
 */
async function refreshPullRequests(
  deps: DepsScanDeps,
  github: NonNullable<DepsScanDeps["github"]>,
  octokit: Octokit,
  project: CurrentProject,
): Promise<{ merged: number; closed: number; edited: number }> {
  const { prisma } = deps;
  const counts = { merged: 0, closed: 0, edited: 0 };
  const open = await prisma.dependencyPullRequest.findMany({ where: { projectId: project.id, state: "OPEN" } });
  if (open.length === 0) return counts;
  const manifests = await prisma.dependencyManifest.findMany({ where: { projectId: project.id }, select: { id: true, path: true } });
  const manifestIdByPath = new Map(manifests.map((m) => [m.path, m.id]));

  for (const pr of open) {
    try {
      const state = await github.getPullRequestState(octokit, project.owner, project.name, pr.number);
      if (!state) continue;
      const at = deps.now?.() ?? new Date();
      let next: "MERGED" | "CLOSED" | "EDITED" | null = null;
      if (state.state === "closed" && state.merged) {
        await prisma.dependencyPullRequest.update({ where: { id: pr.id }, data: { state: "MERGED", closedAt: at } });
        counts.merged++;
        next = "MERGED";
      } else if (state.state === "closed") {
        await prisma.$transaction(async (tx) => {
          await tx.dependencyPullRequest.update({ where: { id: pr.id }, data: { state: "CLOSED", closedAt: at } });
          for (const target of pr.targets) {
            const parsed = parseTarget(target);
            const manifestId = parsed ? manifestIdByPath.get(parsed.manifestPath) : undefined;
            if (!parsed || !manifestId) continue;
            await tx.dependencyUpdate.updateMany({
              where: { manifestId, name: parsed.name, targetVersion: parsed.version, status: "OUTDATED" },
              data: { status: "DISMISSED" },
            });
          }
        });
        counts.closed++;
        next = "CLOSED";
      } else if (state.headSha !== pr.headSha) {
        if (await updateInFlight(deps, project.id, pr.groupKey)) continue;
        const intent = await prisma.dependencyBranchWriteIntent.findUnique({
          where: { projectId_groupKey: { projectId: project.id, groupKey: pr.groupKey } },
        });
        // A bot push can succeed before its job exhausts retries on PR API / DB failures.
        // Keep it eligible for automatic recovery; only the exact durable SHA is trusted.
        if (intent?.commitSha === state.headSha || intent?.previousHeadSha === state.headSha) continue;
        const changed = await prisma.dependencyPullRequest.updateMany({
          where: { id: pr.id, state: "OPEN", headSha: pr.headSha },
          data: { state: "EDITED" },
        });
        if (changed.count === 0) continue;
        counts.edited++;
        next = "EDITED";
        await notifyPullRequestEvent(deps, project, pr.id, "edited", "edited");
      }
      if (next) {
        await publish(deps.redis, project.userId, {
          type: "DEPS_PULL_REQUEST_UPDATED",
          projectId: project.id,
          fullName: project.fullName,
          groupKey: pr.groupKey,
          state: next,
          number: pr.number,
          htmlUrl: pr.htmlUrl,
        });
      }
    } catch (error) {
      log.warn(`${project.fullName}: could not refresh PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return counts;
}

type UpdateRow = Awaited<ReturnType<PrismaClient["dependencyUpdate"]["findMany"]>>[number];

/**
 * §3.11.1 digest: OUTDATED rows not yet notified, at or above the project's `notificationLevel`. `notifiedAt` is
 * set in the transaction that stores durable outbox intents. Enqueue failures leave those intents for the
 * periodic dispatcher. The first scan records a silent baseline unless `notifyOnFirstScan`.
 */
async function queueDigest(
  deps: DepsScanDeps,
  project: CurrentProject,
  outdated: UpdateRow[],
  firstScan: boolean,
  at: Date,
): Promise<number> {
  const fresh = outdated.filter((row) => row.notifiedAt === null);
  if (fresh.length === 0) return 0;
  const silent = firstScan && !project.notifyOnFirstScan;
  const eligible = silent ? fresh : fresh.filter((row) => passesDependencyNotificationLevel(project.notificationLevel, row.level));
  if (eligible.length === 0) return 0;
  const ids = eligible.map((row) => row.id);

  const jobs = await deps.prisma.$transaction(async (tx) => {
    const rules = silent ? [] : await rulesFor(tx as PrismaClient, project.userId, "DEPENDENCY_UPDATES");
    await tx.dependencyUpdate.updateMany({ where: { id: { in: ids }, notifiedAt: null }, data: { notifiedAt: at } });
    const scanId = digestScanId(project.id, eligible);
    const intents = rules.map((rule): DepsNotifyJobData => ({ ruleId: rule.id, projectId: project.id, kind: "digest", scanId, updateIds: ids }));
    await storeNotificationIntents(tx, intents);
    return intents;
  });
  try {
    await flushNotificationOutbox(deps.prisma, deps.notifyQueue);
  } catch (error) {
    log.error(`${project.fullName}: notification intents saved; enqueue will be retried`, error);
  }
  return jobs.length;
}

/**
 * §3.6 step 6, AUTO_PR: a `deps-update` job for each group (within `maxOpenPrs`) whose planned targets differ from
 * its open PR's, or that has no PR yet; and for open PRs whose group vanished (the job closes them). Requires the
 * project to own PRs for the repository; `EDITED` PRs are left alone.
 */
async function queueAutoUpdates(deps: DepsScanDeps, project: CurrentProject, outdated: UpdateRow[]): Promise<number> {
  const { prisma } = deps;
  const ownership = await prisma.dependencyPrOwner.findUnique({ where: { projectId: project.id } });
  if (!ownership || ownership.githubRepoId !== project.githubRepoId) return 0;
  const [manifests, prs] = await Promise.all([
    prisma.dependencyManifest.findMany({ where: { projectId: project.id } }),
    prisma.dependencyPullRequest.findMany({ where: { projectId: project.id } }),
  ]);
  const manifestById = new Map(manifests.map((m) => [m.id, m]));
  const items = outdated.flatMap((row) => {
    const manifest = manifestById.get(row.manifestId);
    if (!manifest || !row.targetVersion) return [];
    return [{ ecosystem: manifest.ecosystem as DependencyEcosystem, name: row.name, manifestPath: manifest.path, level: row.level, row, manifest }];
  });
  const groups = groupUpdates(items, project.groupMode, project.maxOpenPrs);
  const prByGroup = new Map(prs.map((pr) => [pr.groupKey, pr]));
  const keys: string[] = [];
  for (const group of groups) {
    if (!group.hasPrSlot) continue;
    const capability = groupCapability(
      [...new Map(group.updates.map((u) => [u.manifest.id, u.manifest])).values()].map((m) => ({
        path: m.path,
        packageManager: m.packageManager as PackageManager,
        lockfilePath: m.lockfilePath,
      })),
      { lockfileRegeneration: deps.lockfileRegeneration },
    );
    if (!capability.canCreatePr) continue;
    const pr = prByGroup.get(group.groupKey);
    if (pr?.state === "EDITED") continue;
    const targets = [...new Set(group.updates.map((u) => formatTarget({ manifestPath: u.manifestPath, name: u.name, toVersion: u.row.targetVersion! })))].sort();
    if (pr?.state === "OPEN" && pr.targets.length === targets.length && [...pr.targets].sort().every((t, i) => t === targets[i])) continue;
    keys.push(group.groupKey);
  }
  const live = new Set(groups.map((g) => g.groupKey));
  for (const pr of prs) if (pr.state === "OPEN" && !live.has(pr.groupKey)) keys.push(pr.groupKey);
  if (keys.length === 0) return 0;
  await deps.updateQueue.addBulk(
    keys.map((groupKey) => ({
      name: DEPS_JOB_NAMES.update,
      data: { projectId: project.id, groupKey, trigger: "auto" as const },
      opts: { jobId: depsUpdateJobId(project.id, groupKey), priority: DEPS_UPDATE_PRIORITY.auto },
    })),
  );
  return keys.length;
}
