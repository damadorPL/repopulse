import { Worker, type Job, type Queue } from "bullmq";

import { loadDepsEnabled, type Prisma, type PrismaClient } from "@repopulse/db";
import {
  formatTarget,
  groupCapability,
  groupUpdates,
  isRegistryUnavailableError,
  mapWithConcurrency,
  MAX_DEPENDENCIES_PER_PROJECT,
  parseTarget,
  type SemverType,
} from "@repopulse/deps";
import {
  GitHubRateLimitError,
  GitHubRepositoryNotFoundError,
  isGitHubHttpError,
  type GitTreeSnapshot,
} from "@repopulse/github";
import {
  deduplicatedJobOptions,
  DEPS_JOB_NAMES,
  DEPS_QUEUE_NAMES,
  DEPS_UPDATE_PRIORITY,
  depsUpdateJobId,
  rateLimitDelayMs,
  type DepsNotifyJobData,
  type DepsScanJobData,
  type DepsUpdateQueue,
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
} from "../analysis.js";
import { PRIVATE_WITHOUT_APP_MESSAGE, type GitHubAccess, type ReadCandidate } from "../github-access.js";
import { defaultGitHubApi, type GitHubApi, type Octokit } from "../github-api.js";
import { createLogger } from "../logger.js";
import { flushNotificationOutbox, storeNotificationIntents } from "../notification-outbox.js";
import type { BlobCache, LockfileCache, TreeCache } from "../registry-cache.js";
import {
  digestScanId,
  notifyPullRequestEvent,
  passesDependencyNotificationLevel,
  publish,
  rulesFor,
  type NotifyQueue,
} from "./notify-jobs.js";
import { ownerHasPermission, revokePullRequestMode } from "./repo-access.js";

const log = createLogger("deps-scan");

/** Consecutive failures after which a project is paused (like repository polling). */
export const MAX_ERROR_COUNT = 5;
/** A paused project is retried this long after its last failure ("Check now" works at any time). */
export const PAUSED_RESCAN_MS = 7 * 24 * 3600_000;
/** Transient failures (registry down, network) are retried after at most this long. */
const FAILED_RESCAN_MAX_MS = 6 * 3600_000;
/** Interactive transactions of a large project (1,000 rows) need more than Prisma's 5 s default. */
const TRANSACTION_OPTIONS = { timeout: 60_000, maxWait: 10_000 };

/** A private repository read with the App token whose owner no longer has read permission (§3.8.4). */
export const NO_ACCESS_MESSAGE = "You no longer have access to this private repository";

const SCAN_FAILED_MESSAGE = "The dependency check failed. It will be retried on the next scheduled check.";

export interface DepsScanDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, "publish">;
  scanQueue: Pick<Queue<DepsScanJobData>, "rateLimit">;
  updateQueue: Pick<DepsUpdateQueue, "addBulk" | "getDeduplicationJobId">;
  notifyQueue: NotifyQueue;
  access: Pick<GitHubAccess, "readAccess" | "invalidate">;
  github?: Pick<
    GitHubApi,
    | "createOctokit"
    | "fetchGitTree"
    | "readBlobs"
    | "getPullRequestState"
    | "getCollaboratorPermission"
    | "getUserLoginById"
  >;
  registry: RegistryLookupFn;
  blobCache?: BlobCache | null;
  lockCache?: LockfileCache | null;
  treeCache?: TreeCache | null;
  loadDepsEnabled?: () => Promise<boolean>;
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
  knownCommitSha: string | null,
  signal: AbortSignal | undefined,
): Promise<{ snapshot: GitTreeSnapshot; candidate: ReadCandidate; octokit: Octokit }> {
  for (const [index, candidate] of candidates.entries()) {
    const octokit = github.createOctokit({ accessToken: candidate.token });
    try {
      const snapshot = await github.fetchGitTree({
        owner: project.owner,
        name: project.name,
        repositoryId: Number(project.githubRepoId),
        ...(knownCommitSha ? { knownCommitSha } : {}),
        octokit,
        ...(signal ? { signal } : {}),
      });
      return { snapshot, candidate, octokit };
    } catch (error) {
      if (isGitHubHttpError(error) && error.status === 401) {
        if (candidate.source === "app" && installationId !== null) deps.access.invalidate(installationId);
        if (index < candidates.length - 1) {
          log.warn(
            { queue: DEPS_QUEUE_NAMES.scan, projectId: project.id, source: candidate.source },
            `${project.fullName}: ${candidate.source} token was rejected (401); trying the next one`,
          );
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

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

interface ManifestData {
  ecosystem: "NPM" | "PYPI";
  packageManager: "NPM" | "PNPM" | "BUN" | "YARN" | "PIP" | "PIP_TOOLS" | "UV" | "POETRY" | "NONE";
  lockfilePath: string | null;
  workspaceRoot: string | null;
  blobSha: string;
  dependencyCount: number;
  warnings: string[];
}

function manifestChanged(existing: ManifestData, next: ManifestData): boolean {
  return (
    existing.ecosystem !== next.ecosystem ||
    existing.packageManager !== next.packageManager ||
    existing.lockfilePath !== next.lockfilePath ||
    existing.workspaceRoot !== next.workspaceRoot ||
    existing.blobSha !== next.blobSha ||
    existing.dependencyCount !== next.dependencyCount ||
    !sameStringArray(existing.warnings, next.warnings)
  );
}

const UPDATE_BATCH_SIZE = 50;
const CREATE_BATCH_SIZE = 500;

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
export async function processDepsScan(
  job: Job<DepsScanJobData>,
  deps: DepsScanDeps,
  signal?: AbortSignal,
): Promise<DepsScanOutcome> {
  const { prisma } = deps;
  const github = deps.github ?? defaultGitHubApi;
  const now = () => deps.now?.() ?? new Date();
  const { projectId, trigger } = job.data;
  const ctx = { queue: DEPS_QUEUE_NAMES.scan, jobId: job.id, projectId };

  const enabled = deps.loadDepsEnabled ? await deps.loadDepsEnabled() : await loadDepsEnabled(prisma);
  if (!enabled) {
    log.info(ctx, `project ${projectId}: dependency checks are disabled; scan skipped`);
    return { status: "SKIPPED", reason: "DISABLED" };
  }
  const project = await prisma.dependencyProject.findUnique({ where: { id: projectId } });
  if (!project) return { status: "SKIPPED", reason: "PROJECT_GONE" };
  const user = await prisma.user.findUnique({
    where: { id: project.userId },
    select: { id: true, githubId: true, githubLogin: true, githubAccessTokenEncrypted: true },
  });
  if (!user) return { status: "SKIPPED", reason: "PROJECT_GONE" };

  const requester = job.data.requestedByUserId ?? (trigger === "manual" ? project.userId : undefined);
  const scanFailed = (message: string) =>
    requester
      ? publish(deps.redis, requester, { type: "DEPS_SCAN_FAILED", projectId, fullName: project.fullName, message })
      : Promise.resolve();
  const intervalMs = project.scanIntervalHours * 3600_000;

  /** Atomic failure persistence: computes `nextScanAt` + `errorCount` (and optional `isPrivate`) in one query. */
  const recordScanFailure = async (opts: {
    message: string;
    countIt: boolean;
    normalRescanMs: number;
    markPrivate?: boolean;
  }): Promise<number> => {
    const at = now();
    const normalNextScanAt = new Date(at.getTime() + opts.normalRescanMs);
    const pausedNextScanAt = new Date(at.getTime() + PAUSED_RESCAN_MS);
    let errorCount: number;
    if (typeof (prisma as { $queryRaw?: unknown }).$queryRaw === "function") {
      const increment = opts.countIt ? 1 : 0;
      const markPrivate = Boolean(opts.markPrivate);
      const rows = await prisma.$queryRaw<Array<{ errorCount: number }>>`
        UPDATE "DependencyProject"
        SET
          "scanStatus" = 'ERROR'::"DepsScanStatus",
          "scanError" = ${opts.message},
          "errorCount" = "errorCount" + ${increment},
          "nextScanAt" = CASE
            WHEN ${opts.countIt} AND "errorCount" + ${increment} >= ${MAX_ERROR_COUNT} THEN ${pausedNextScanAt}
            ELSE ${normalNextScanAt}
          END,
          "isPrivate" = CASE WHEN ${markPrivate} THEN true ELSE "isPrivate" END,
          "updatedAt" = ${at}
        WHERE "id" = ${projectId}
        RETURNING "errorCount"
      `;
      errorCount = rows[0]?.errorCount ?? project.errorCount + increment;
    } else {
      const paused = opts.countIt && project.errorCount + 1 >= MAX_ERROR_COUNT;
      const updated = await prisma.dependencyProject.update({
        where: { id: projectId },
        data: {
          scanStatus: "ERROR",
          scanError: opts.message,
          nextScanAt: paused ? pausedNextScanAt : normalNextScanAt,
          ...(opts.countIt ? { errorCount: { increment: 1 } } : {}),
          ...(opts.markPrivate ? { isPrivate: true } : {}),
        },
        select: { errorCount: true },
      });
      errorCount = updated.errorCount;
    }
    await scanFailed(opts.message);
    return errorCount;
  };

  /** Handled failure: user-safe `scanError`, `ERROR`, no BullMQ retry. */
  const recordHandled = (message: string, countIt: boolean, markPrivate = false): Promise<number> =>
    recordScanFailure({ message, countIt, normalRescanMs: intervalMs, markPrivate });

  await prisma.dependencyProject.update({
    where: { id: projectId },
    data: { scanStatus: "SCANNING" },
    select: { id: true },
  });
  const firstScan = project.lastScannedAt === null;

  try {
    // Step 1: read credentials.
    const access = await deps.access.readAccess(project, user);
    if (access.kind === "private-without-app") {
      log.warn(ctx, `${project.fullName}: private repository without the GitHub App`);
      await recordHandled(access.message, false);
      return { status: "PRIVATE_WITHOUT_APP" };
    }

    // Step 2: tree + metadata (reuse cached Git tree when HEAD has not moved).
    const cachedTree =
      project.lastScannedSha && deps.treeCache
        ? await deps.treeCache.get(project.githubRepoId, project.lastScannedSha)
        : null;
    const fetched = await fetchWithFallback(
      deps,
      github,
      project,
      access.candidates,
      access.installationId,
      cachedTree ? project.lastScannedSha : null,
      signal,
    );
    const { candidate, octokit } = fetched;
    let { snapshot } = fetched;
    if (BigInt(snapshot.repository.id) !== project.githubRepoId)
      throw new GitHubRepositoryNotFoundError(project.owner, project.name);
    if (snapshot.unchanged && cachedTree) {
      snapshot = { ...snapshot, entries: cachedTree.entries, truncated: cachedTree.truncated };
    } else if (snapshot.commitSha && deps.treeCache) {
      await deps.treeCache.set(BigInt(snapshot.repository.id), snapshot.commitSha, {
        entries: snapshot.entries,
        truncated: snapshot.truncated,
      });
    }
    if (snapshot.repository.isPrivate && candidate.source !== "app") {
      await recordHandled(PRIVATE_WITHOUT_APP_MESSAGE, false, true);
      return { status: "PRIVATE_WITHOUT_APP" };
    }
    // Private repository read with the App token: the installation alone never grants access, so the owner's
    // read permission is checked on every scan. Without it nothing new is written and PR modes are revoked.
    if (
      snapshot.repository.isPrivate &&
      !(await ownerHasPermission(prisma, github, octokit, snapshot.repository, user, "read"))
    ) {
      const switchedToNotify = await revokePullRequestMode(deps, project, null, now());
      log.warn(
        ctx,
        `${project.fullName}: the owner has no read access to the private repository${switchedToNotify ? "; switched to notify-only" : ""}`,
      );
      await recordHandled(NO_ACCESS_MESSAGE, false);
      return { status: "NO_ACCESS", switchedToNotify };
    }
    const repo = snapshot.repository;
    const reader = createSnapshotReader(
      snapshot.entries,
      (refs, maxBytes) =>
        github.readBlobs(octokit, repo.owner, repo.name, refs, { maxBytes, ...(signal ? { signal } : {}) }),
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
      prisma.dependencyManifest.findMany({
        where: { projectId },
        select: {
          id: true,
          path: true,
          ecosystem: true,
          packageManager: true,
          lockfilePath: true,
          workspaceRoot: true,
          blobSha: true,
          dependencyCount: true,
          warnings: true,
        },
      }),
      prisma.dependencyUpdate.findMany({ where: { projectId } }),
    ]);
    const manifestPathById = new Map(storedManifests.map((m) => [m.id, m.path]));
    const dismissed = new Map<string, string>();
    for (const row of storedUpdates) {
      const path = manifestPathById.get(row.manifestId);
      if (row.status === "DISMISSED" && row.targetVersion && path)
        dismissed.set(rowKey(path, row.name, row.kind, row.group), row.targetVersion);
    }
    const lookups = await lookupRegistries(
      analysis.manifests.flatMap((m) =>
        m.dependencies
          .filter((d) => d.dependency.supported)
          .map((d) => ({ ecosystem: d.ecosystem, name: d.dependency.name })),
      ),
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
    const detectedPathSet = new Set(detectedPaths);
    const storedByPath = new Map(storedManifests.map((m) => [m.path, m]));
    const manifestIds = await prisma.$transaction(async (tx) => {
      if (storedManifests.some((m) => !detectedPathSet.has(m.path))) {
        await tx.dependencyManifest.deleteMany({ where: { projectId, path: { notIn: detectedPaths } } });
      }
      const idsByPath = new Map<string, string>();
      const manifestsToCreate: Array<ManifestData & { projectId: string; path: string }> = [];
      const manifestsToUpdate: Array<{ id: string; data: ManifestData }> = [];

      for (const [index, manifest] of analysis.manifests.entries()) {
        const { detected } = manifest;
        // Project-level warnings (manifest / dependency caps) are shown with the first manifest.
        const warnings = index === 0 ? [...new Set([...analysis.warnings, ...manifest.warnings])] : manifest.warnings;
        const data: ManifestData = {
          ecosystem: detected.ecosystem,
          packageManager: detected.packageManager,
          lockfilePath: detected.lockfilePath,
          workspaceRoot: detected.workspaceRoot,
          blobSha: detected.blobSha ?? "",
          dependencyCount: manifest.dependencies.length,
          warnings,
        };
        const existing = storedByPath.get(detected.path);
        if (!existing) {
          manifestsToCreate.push({ projectId, path: detected.path, ...data });
        } else {
          idsByPath.set(detected.path, existing.id);
          if (manifestChanged(existing, data)) manifestsToUpdate.push({ id: existing.id, data });
        }
      }
      if (manifestsToCreate.length > 0) {
        const created = await tx.dependencyManifest.createManyAndReturn({
          data: manifestsToCreate,
          select: { id: true, path: true },
        });
        for (const row of created) idsByPath.set(row.path, row.id);
      }
      if (manifestsToUpdate.length > 0) {
        await Promise.all(
          manifestsToUpdate.map((entry) =>
            tx.dependencyManifest.update({ where: { id: entry.id }, data: entry.data, select: { id: true } }),
          ),
        );
      }

      const keep = new Set<string>();
      const toCreate: Prisma.DependencyUpdateCreateManyInput[] = [];
      const toUpdate: Array<{ id: string; data: RowData; firstSeenAt: Date; notifiedAt: Date | null }> = [];
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
            manifestId: idsByPath.get(path)!,
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
          toUpdate.push({
            id: existing.id,
            data,
            // Same target: keep firstSeenAt / notifiedAt. A new target is new news.
            firstSeenAt: sameTarget ? existing.firstSeenAt : scannedAt,
            notifiedAt: sameTarget ? existing.notifiedAt : null,
          });
        }
      }
      if (toUpdate.length > 0) {
        toUpdate.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (toUpdate.length > 1 && typeof (tx as { $executeRaw?: unknown }).$executeRaw === "function") {
          const payload = toUpdate.map((entry) => ({
            id: entry.id,
            declared: entry.data.declared,
            currentVersion: entry.data.currentVersion,
            wantedVersion: entry.data.wantedVersion,
            targetVersion: entry.data.targetVersion,
            latestVersion: entry.data.latestVersion,
            level: entry.data.level,
            status: entry.data.status,
            targetReleasedAt: entry.data.targetReleasedAt ? entry.data.targetReleasedAt.toISOString() : null,
            sourceRepoUrl: entry.data.sourceRepoUrl,
            firstSeenAt: entry.firstSeenAt.toISOString(),
            notifiedAt: entry.notifiedAt ? entry.notifiedAt.toISOString() : null,
          }));
          await tx.$executeRaw`
            UPDATE "DependencyUpdate" AS u
            SET
              "declared" = v."declared",
              "currentVersion" = v."currentVersion",
              "wantedVersion" = v."wantedVersion",
              "targetVersion" = v."targetVersion",
              "latestVersion" = v."latestVersion",
              "level" = v."level"::"SemverType",
              "status" = v."status"::"DependencyUpdateStatus",
              "targetReleasedAt" = v."targetReleasedAt",
              "sourceRepoUrl" = v."sourceRepoUrl",
              "firstSeenAt" = v."firstSeenAt",
              "notifiedAt" = v."notifiedAt"
            FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS v(
              "id" text,
              "declared" text,
              "currentVersion" text,
              "wantedVersion" text,
              "targetVersion" text,
              "latestVersion" text,
              "level" text,
              "status" text,
              "targetReleasedAt" timestamptz,
              "sourceRepoUrl" text,
              "firstSeenAt" timestamptz,
              "notifiedAt" timestamptz
            )
            WHERE u."id" = v."id"
          `;
        } else {
          for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH_SIZE) {
            const batch = toUpdate.slice(i, i + UPDATE_BATCH_SIZE);
            await Promise.all(
              batch.map((entry) =>
                tx.dependencyUpdate.update({
                  where: { id: entry.id },
                  data: { ...entry.data, firstSeenAt: entry.firstSeenAt, notifiedAt: entry.notifiedAt },
                  select: { id: true },
                }),
              ),
            );
          }
        }
      }
      const stale = [...existingByKey].filter(([key]) => !keep.has(key)).map(([, row]) => row.id);
      if (stale.length > 0) await tx.dependencyUpdate.deleteMany({ where: { id: { in: stale } } });
      for (let i = 0; i < toCreate.length; i += CREATE_BATCH_SIZE) {
        await tx.dependencyUpdate.createMany({
          data: toCreate.slice(i, i + CREATE_BATCH_SIZE),
          skipDuplicates: true,
        });
      }

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
        select: { id: true },
      });
      return idsByPath;
    }, TRANSACTION_OPTIONS);
    const current = {
      ...project,
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
    };

    // Step 5: refresh open pull requests.
    const prCounts = await refreshPullRequests(deps, github, octokit, current, manifestIds);

    // Step 6: SSE, digest, auto PRs.
    const outdatedRows = await prisma.dependencyUpdate.findMany({
      where: { projectId, status: "OUTDATED" },
      select: { id: true, manifestId: true, name: true, targetVersion: true, level: true, notifiedAt: true },
    });
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
      project.updateMode === "AUTO_PR" && access.installationId !== null
        ? await queueAutoUpdates(deps, current, outdatedRows, analysis.manifests, manifestIds)
        : 0;

    const dependencies = analysis.manifests.reduce((sum, m) => sum + m.dependencies.length, 0);
    log.info(
      {
        ...ctx,
        manifests: analysis.manifests.length,
        dependencies,
        outdated: outdatedRows.length,
        majors,
        digests,
        autoUpdates,
      },
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
      await prisma.dependencyProject.update({
        where: { id: projectId },
        data: { scanStatus: "QUEUED" },
        select: { id: true },
      });
      await deps.scanQueue.rateLimit(delayMs);
      log.warn(
        { ...ctx, delayMs },
        `${project.fullName}: GitHub rate limit exceeded; pausing deps-scan for ${Math.ceil(delayMs / 1000)}s`,
      );
      throw Worker.RateLimitError();
    }
    if (error instanceof GitHubRepositoryNotFoundError) {
      const errorCount = await recordHandled(notFoundMessage(project.fullName), true);
      log.warn({ ...ctx, errorCount }, `${project.fullName}: not found (errorCount ${errorCount}/${MAX_ERROR_COUNT})`);
      return { status: "NOT_FOUND", errorCount };
    }

    // Registry 429 / 5xx, network, anything else: BullMQ retries; the previous results stay. Only the last attempt counts.
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    const message = isRegistryUnavailableError(error) ? registryMessage(error) : SCAN_FAILED_MESSAGE;
    try {
      if (finalAttempt) {
        await recordScanFailure({
          message,
          countIt: true,
          normalRescanMs: Math.min(intervalMs, FAILED_RESCAN_MAX_MS),
        });
      } else {
        await prisma.dependencyProject.update({
          where: { id: projectId },
          data: { scanStatus: "QUEUED" },
          select: { id: true },
        });
      }
    } catch (recordError) {
      log.error({ ...ctx, err: recordError }, `${project.fullName}: could not record the failure`);
    }
    log.warn(
      { ...ctx, attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1, err: error },
      `${project.fullName}: attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

type CurrentProject = ProjectRow;

/** Whether an update job for the group is waiting or running (its push must not be mistaken for a human edit). */
async function updateInFlight(deps: DepsScanDeps, projectId: string, groupKey: string): Promise<boolean> {
  try {
    const existingId = await deps.updateQueue.getDeduplicationJobId(depsUpdateJobId(projectId, groupKey));
    return existingId !== null;
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
  manifestIdByPath: ReadonlyMap<string, string>,
): Promise<{ merged: number; closed: number; edited: number }> {
  const { prisma } = deps;
  const counts = { merged: 0, closed: 0, edited: 0 };
  const open = await prisma.dependencyPullRequest.findMany({
    where: { projectId: project.id, state: "OPEN" },
    select: { id: true, groupKey: true, number: true, htmlUrl: true, headSha: true, targets: true },
  });
  if (open.length === 0) return counts;

  const results = await mapWithConcurrency(
    open,
    async (pr) => {
      try {
        const state = await github.getPullRequestState(octokit, project.owner, project.name, pr.number);
        if (!state) return null;
        const at = deps.now?.() ?? new Date();
        let next: "MERGED" | "CLOSED" | "EDITED" | null = null;
        if (state.state === "closed" && state.merged) {
          await prisma.$transaction(async (tx) => {
            await tx.dependencyPullRequest.update({
              where: { id: pr.id },
              data: { state: "MERGED", closedAt: at },
              select: { id: true },
            });
            await tx.dependencyBranchWriteIntent.deleteMany({
              where: { projectId: project.id, groupKey: pr.groupKey },
            });
          });
          next = "MERGED";
        } else if (state.state === "closed") {
          const targetFilters = pr.targets.flatMap((target) => {
            const parsed = parseTarget(target);
            const manifestId = parsed ? manifestIdByPath.get(parsed.manifestPath) : undefined;
            return parsed && manifestId ? [{ manifestId, name: parsed.name, targetVersion: parsed.version }] : [];
          });
          await prisma.$transaction(async (tx) => {
            await tx.dependencyPullRequest.update({
              where: { id: pr.id },
              data: { state: "CLOSED", closedAt: at },
              select: { id: true },
            });
            if (targetFilters.length > 0) {
              await tx.dependencyUpdate.updateMany({
                where: { projectId: project.id, status: "OUTDATED", OR: targetFilters },
                data: { status: "DISMISSED" },
              });
            }
            await tx.dependencyBranchWriteIntent.deleteMany({
              where: { projectId: project.id, groupKey: pr.groupKey },
            });
          });
          next = "CLOSED";
        } else if (state.headSha !== pr.headSha) {
          if (await updateInFlight(deps, project.id, pr.groupKey)) return null;
          const intent = await prisma.dependencyBranchWriteIntent.findUnique({
            where: { projectId_groupKey: { projectId: project.id, groupKey: pr.groupKey } },
          });
          // A bot push can succeed before its job exhausts retries on PR API / DB failures.
          // Keep it eligible for automatic recovery; only the exact durable SHA is trusted.
          if (intent?.commitSha === state.headSha || intent?.previousHeadSha === state.headSha) return null;
          const changedCount = await prisma.$transaction(async (tx) => {
            const changed = await tx.dependencyPullRequest.updateMany({
              where: { id: pr.id, state: "OPEN", headSha: pr.headSha },
              data: { state: "EDITED" },
            });
            if (changed.count > 0) {
              await tx.dependencyBranchWriteIntent.deleteMany({
                where: { projectId: project.id, groupKey: pr.groupKey },
              });
            }
            return changed.count;
          });
          if (changedCount === 0) return null;
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
        return next;
      } catch (error) {
        log.warn(
          { queue: DEPS_QUEUE_NAMES.scan, projectId: project.id, prNumber: pr.number, err: error },
          `${project.fullName}: could not refresh PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    },
    4,
  );
  for (const next of results) {
    if (next === "MERGED") counts.merged++;
    else if (next === "CLOSED") counts.closed++;
    else if (next === "EDITED") counts.edited++;
  }
  return counts;
}

type OutdatedScanRow = Pick<
  Awaited<ReturnType<PrismaClient["dependencyUpdate"]["findMany"]>>[number],
  "id" | "manifestId" | "name" | "targetVersion" | "level" | "notifiedAt"
>;

/**
 * §3.11.1 digest: OUTDATED rows not yet notified, at or above the project's `notificationLevel`. `notifiedAt` is
 * set in the transaction that stores durable outbox intents. Enqueue failures leave those intents for the
 * periodic dispatcher. The first scan records a silent baseline unless `notifyOnFirstScan`.
 */
async function queueDigest(
  deps: DepsScanDeps,
  project: CurrentProject,
  outdated: OutdatedScanRow[],
  firstScan: boolean,
  at: Date,
): Promise<number> {
  const fresh = outdated.filter((row) => row.notifiedAt === null);
  if (fresh.length === 0) return 0;
  const silent = firstScan && !project.notifyOnFirstScan;
  const eligible = silent
    ? fresh
    : fresh.filter((row) => passesDependencyNotificationLevel(project.notificationLevel, row.level));
  if (eligible.length === 0) return 0;
  const ids = eligible.map((row) => row.id);

  const jobs = await deps.prisma.$transaction(async (tx) => {
    const rules = silent ? [] : await rulesFor(tx, project.userId, "DEPENDENCY_UPDATES");
    await tx.dependencyUpdate.updateMany({ where: { id: { in: ids }, notifiedAt: null }, data: { notifiedAt: at } });
    const scanId = digestScanId(project.id, eligible);
    const intents = rules.map((rule): DepsNotifyJobData => ({
      ruleId: rule.id,
      projectId: project.id,
      kind: "digest",
      scanId,
      updateIds: ids,
    }));
    await storeNotificationIntents(tx, intents);
    return intents;
  });
  try {
    await flushNotificationOutbox(deps.prisma, deps.notifyQueue);
  } catch (error) {
    log.error(
      { queue: DEPS_QUEUE_NAMES.scan, projectId: project.id, err: error },
      `${project.fullName}: notification intents saved; enqueue will be retried`,
    );
  }
  return jobs.length;
}

/**
 * §3.6 step 6, AUTO_PR: a `deps-update` job for each group (within `maxOpenPrs`) whose planned targets differ from
 * its open PR's, or that has no PR yet; and for open PRs whose group vanished (the job closes them). Requires the
 * project to own PRs for the repository; `EDITED` PRs are left alone.
 */
async function queueAutoUpdates(
  deps: DepsScanDeps,
  project: CurrentProject,
  outdated: OutdatedScanRow[],
  analyzedManifests: ReadonlyArray<{
    detected: {
      path: string;
      ecosystem: "NPM" | "PYPI";
      packageManager: "NPM" | "PNPM" | "BUN" | "YARN" | "PIP" | "PIP_TOOLS" | "UV" | "POETRY" | "NONE";
      lockfilePath: string | null;
    };
  }>,
  manifestIds: ReadonlyMap<string, string>,
): Promise<number> {
  const { prisma } = deps;
  const ownership = await prisma.dependencyPrOwner.findUnique({ where: { projectId: project.id } });
  if (!ownership || ownership.githubRepoId !== project.githubRepoId) return 0;
  const prs = await prisma.dependencyPullRequest.findMany({
    where: { projectId: project.id },
    select: { groupKey: true, state: true, targets: true },
  });
  const manifestById = new Map(
    analyzedManifests.flatMap((m) => {
      const id = manifestIds.get(m.detected.path);
      return id
        ? [
            [
              id,
              {
                id,
                path: m.detected.path,
                ecosystem: m.detected.ecosystem,
                packageManager: m.detected.packageManager,
                lockfilePath: m.detected.lockfilePath,
              },
            ] as const,
          ]
        : [];
    }),
  );
  const items = outdated.flatMap((row) => {
    const manifest = manifestById.get(row.manifestId);
    if (!manifest || !row.targetVersion) return [];
    return [
      { ecosystem: manifest.ecosystem, name: row.name, manifestPath: manifest.path, level: row.level, row, manifest },
    ];
  });
  const groups = groupUpdates(items, project.groupMode, project.maxOpenPrs);
  const prByGroup = new Map(prs.map((pr) => [pr.groupKey, pr]));
  const keys: string[] = [];
  for (const group of groups) {
    if (!group.hasPrSlot) continue;
    const capability = groupCapability(
      [...new Map(group.updates.map((u) => [u.manifest.id, u.manifest])).values()].map((m) => ({
        path: m.path,
        packageManager: m.packageManager,
        lockfilePath: m.lockfilePath,
      })),
      { lockfileRegeneration: deps.lockfileRegeneration },
    );
    if (!capability.canCreatePr) continue;
    const pr = prByGroup.get(group.groupKey);
    if (pr?.state === "EDITED") continue;
    const targets = [
      ...new Set(
        group.updates.map((u) =>
          formatTarget({ manifestPath: u.manifestPath, name: u.name, toVersion: u.row.targetVersion! }),
        ),
      ),
    ].toSorted();
    if (
      pr?.state === "OPEN" &&
      pr.targets.length === targets.length &&
      pr.targets.toSorted().every((t, i) => t === targets[i])
    )
      continue;
    keys.push(group.groupKey);
  }
  const live = new Set(groups.map((g) => g.groupKey));
  for (const pr of prs) if (pr.state === "OPEN" && !live.has(pr.groupKey)) keys.push(pr.groupKey);
  if (keys.length === 0) return 0;
  await deps.updateQueue.addBulk(
    keys.map((groupKey) => ({
      name: DEPS_JOB_NAMES.update,
      data: { projectId: project.id, groupKey, trigger: "auto" as const },
      opts: deduplicatedJobOptions(depsUpdateJobId(project.id, groupKey), DEPS_UPDATE_PRIORITY.auto),
    })),
  );
  return keys.length;
}
