import { UnrecoverableError, Worker, type Job, type Queue } from "bullmq";
import { loadDepsEnabled, type PrismaClient } from "@repopulse/db";
import {
  buildCommitMessage,
  buildPrBody,
  buildPrTitle,
  buildTargets,
  depsBranchName,
  groupCapability,
  groupUpdates,
  isManifestRewriteError,
  isValidGroupKey,
  manifestNeedsLockfile,
  MAX_LOCKFILE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_SANDBOX_FILES,
  rewritePackageJson,
  rewritePyproject,
  rewriteRequirements,
  SANDBOX_PACKAGE_MANAGERS,
  SKIPPED_DIRECTORIES,
  type ManifestEdit,
  type PrUpdate,
  type SandboxPackageManager,
  type SkippedUpdate,
} from "@repopulse/deps";
import {
  GitHubAppAuthError,
  GitHubRateLimitError,
  GitHubRepositoryNotFoundError,
  gitBlobSha,
  RefUpdateConflictError,
} from "@repopulse/github";
import { resolveAppBaseUrl } from "@repopulse/notifications";
import type { DepsUpdateJobData, Redis } from "@repopulse/queue";
import {
  analyzeProject,
  createSnapshotReader,
  lookupRegistries,
  planAnalysis,
  rowKey,
  type AnalyzedManifest,
  type PlannedDependency,
  type RegistryLookupFn,
} from "../analysis";
import type { GitHubAccess } from "../github-access";
import { defaultGitHubApi, type GitHubApi, type Octokit } from "../github-api";
import { createLogger } from "../logger";
import { rateLimitDelayMs } from "../rate-limit";
import type { BlobCache, LockfileCache } from "../registry-cache";
import {
  SandboxBusyError,
  SandboxLockError,
  SandboxUnavailableError,
  validateLockfile,
  type SandboxClient,
} from "../sandbox-client";
import { notifyPullRequestEvent, publish, type NotifyQueue } from "./notify-jobs";
import { ownerHasPermission, revokePullRequestMode } from "./repo-access";

const log = createLogger("deps-update");

export const EMPTY_GROUP_COMMENT = "All updates in this group were applied or are no longer wanted. Closing this pull request.";
export const UPDATE_FAILED_MESSAGE = "The update pull request could not be created. It will be retried later.";

export interface DepsUpdateDeps {
  prisma: PrismaClient;
  redis: Pick<Redis, "publish">;
  updateQueue: Pick<Queue<DepsUpdateJobData>, "rateLimit">;
  notifyQueue: NotifyQueue;
  access: Pick<GitHubAccess, "app" | "installation" | "installationToken" | "invalidate">;
  github?: Pick<
    GitHubApi,
    | "createOctokit"
    | "fetchGitTree"
    | "readBlobs"
    | "getCollaboratorPermission"
    | "getUserLoginById"
    | "inspectBranch"
    | "treeHasContent"
    | "commitFiles"
    | "upsertPullRequest"
    | "closePullRequest"
  >;
  /** Registry lookups that revalidate (the update recomputes the group from fresh registry data). */
  registry: RegistryLookupFn;
  blobCache?: BlobCache | null;
  lockCache?: LockfileCache | null;
  /** `null` = no sandbox configured: groups that need a lockfile are refused. */
  sandbox: SandboxClient | null;
  appBaseUrl?: string;
  now?: () => Date;
}

export type DepsUpdateOutcome =
  | { status: "SKIPPED"; reason: "DISABLED" | "PROJECT_GONE" | "MODE_CHANGED" | "NO_PR_SLOT" }
  | { status: "CLOSED"; number: number }
  | { status: "NOTHING_TO_DO" }
  | { status: "EDITED"; number: number }
  | { status: "OPENED" | "UPDATED" | "UNCHANGED"; number: number; headSha: string; files: string[] };

/** A user-safe refusal: the job fails without retries and the PR card shows `message` (SSE `FAILED`). */
class Refusal extends Error {}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/**
 * Registry / index config the package manager would read. Sent so the sandbox can detect a custom registry and
 * answer `UNSUPPORTED_REGISTRY` (it deletes these files before running): never sending them would let a lockfile
 * meant for a private registry be regenerated against the public one (dependency confusion).
 */
const NPM_REGISTRY_CONFIG_FILES = [".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", ".bunfig.toml"];
const PYTHON_REGISTRY_CONFIG_FILES = ["pip.conf", "pip.ini", "poetry.toml", "uv.toml"];
const NPM_WORKSPACE_FILES = new Set(["package.json", "pnpm-workspace.yaml", ...NPM_REGISTRY_CONFIG_FILES]);
const PYTHON_WORKSPACE_FILES = new Set(["pyproject.toml", ".python-version", ...PYTHON_REGISTRY_CONFIG_FILES]);

/**
 * Workspace files the sandbox needs: manifests and registry config under the lockfile's directory (no source code),
 * plus the lockfile.
 */
export function workspaceFilePaths(
  entries: ReadonlyArray<{ path: string; type: string }>,
  lockfilePath: string,
  packageManager: SandboxPackageManager,
): string[] {
  const workdir = dirname(lockfilePath);
  const names = packageManager === "UV" || packageManager === "POETRY" ? PYTHON_WORKSPACE_FILES : NPM_WORKSPACE_FILES;
  const paths = entries
    .filter((entry) => entry.type === "blob")
    .map((entry) => entry.path)
    .filter((path) => workdir === "" || path.startsWith(`${workdir}/`))
    .filter((path) => names.has(basename(path)))
    .filter((path) => !path.split("/").slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment)));
  return [...new Set([...paths, lockfilePath])].sort();
}

type GroupItem = PlannedDependency & { name: string; manifestPath: string; level: PlannedDependency["selection"]["level"] };

/**
 * `deps-update` job (Slice 08 §3.9): server-side checks (mode, PR ownership, App installation, the owner's write
 * permission on every job), recompute the group from stored rows + fresh registry data, span-edit the manifests,
 * regenerate lockfiles in the sandbox (validated here), commit to `repopulse/deps/<groupKey>` unless someone else
 * pushed there, and open or refresh the PR.
 */
export async function processDepsUpdate(job: Job<DepsUpdateJobData>, deps: DepsUpdateDeps, signal?: AbortSignal): Promise<DepsUpdateOutcome> {
  const { prisma } = deps;
  const { projectId, groupKey } = job.data;
  const now = () => deps.now?.() ?? new Date();

  if (!(await loadDepsEnabled(prisma))) {
    log.info(`project ${projectId}: dependency checks are disabled; update skipped`);
    return { status: "SKIPPED", reason: "DISABLED" };
  }
  const project = await prisma.dependencyProject.findUnique({ where: { id: projectId } });
  if (!project) return { status: "SKIPPED", reason: "PROJECT_GONE" };
  const prRow = await prisma.dependencyPullRequest.findUnique({ where: { projectId_groupKey: { projectId, groupKey } } });
  const label = `${project.fullName} [${groupKey}]`;

  const failed = (message: string) =>
    publish(deps.redis, project.userId, {
      type: "DEPS_PULL_REQUEST_UPDATED",
      projectId,
      fullName: project.fullName,
      groupKey,
      state: "FAILED",
      number: prRow?.number ?? null,
      htmlUrl: prRow?.htmlUrl ?? null,
      message,
    });

  try {
    if (!isValidGroupKey(groupKey)) throw new Refusal("Invalid pull request group.");
    for (let attempt = 0; ; attempt++) {
      try {
        return await runUpdate(job, deps, project, prRow, signal, now);
      } catch (error) {
        // A push raced our ref update: start again from step 2 once.
        if (error instanceof RefUpdateConflictError && attempt === 0) {
          log.warn(`${label}: ${error.message}; retrying once`);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof Refusal) {
      log.warn(`${label}: refused: ${error.message}`);
      await failed(error.message);
      throw new UnrecoverableError(error.message);
    }
    if (error instanceof GitHubRateLimitError) {
      const delayMs = rateLimitDelayMs(error.resetAt, now());
      await deps.updateQueue.rateLimit(delayMs);
      log.warn(`${label}: GitHub rate limit exceeded; pausing deps-update for ${Math.ceil(delayMs / 1000)}s`);
      throw Worker.RateLimitError();
    }
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    log.warn(`${label}: attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (finalAttempt) {
      await failed(error instanceof SandboxBusyError || error instanceof SandboxUnavailableError ? error.message : UPDATE_FAILED_MESSAGE);
    }
    throw error;
  }
}

type ProjectRow = NonNullable<Awaited<ReturnType<PrismaClient["dependencyProject"]["findUnique"]>>>;
type PrRow = Awaited<ReturnType<PrismaClient["dependencyPullRequest"]["findUnique"]>>;

async function jobLog(job: Job, line: string): Promise<void> {
  try {
    if (typeof job.log === "function") await job.log(line);
  } catch {
    // the job log is best effort
  }
}

async function runUpdate(
  job: Job<DepsUpdateJobData>,
  deps: DepsUpdateDeps,
  project: ProjectRow,
  prRow: PrRow,
  signal: AbortSignal | undefined,
  now: () => Date,
): Promise<DepsUpdateOutcome> {
  const { prisma } = deps;
  const github = deps.github ?? defaultGitHubApi;
  const { groupKey } = job.data;
  const label = `${project.fullName} [${groupKey}]`;

  // Step 1: server-side checks, on every job.
  if (project.updateMode === "NOTIFY") throw new Refusal("Pull requests are turned off for this project (notify-only mode).");
  if (job.data.trigger === "auto" && project.updateMode !== "AUTO_PR") return { status: "SKIPPED", reason: "MODE_CHANGED" };
  const ownership = await prisma.dependencyPrOwner.findUnique({ where: { projectId: project.id } });
  if (!ownership || ownership.githubRepoId !== project.githubRepoId) {
    throw new Refusal("Another RepoPulse user manages pull requests for this repository.");
  }
  const app = await deps.access.app();
  if (!app) throw new Refusal("The GitHub App is not set up. Ask the administrator to configure it in Admin → GitHub App.");
  const user = await prisma.user.findUnique({ where: { id: project.userId }, select: { id: true, githubId: true, githubLogin: true } });
  if (!user) throw new Refusal("The project owner no longer exists.");

  const loseAccess = async (reason: string): Promise<never> => {
    await revokePullRequestMode(deps, project, prRow?.id ?? null, now());
    throw new Refusal(`${reason} The project was switched to notify-only.`);
  };

  // Strict: only a confirmed "not installed" switches the project to notify-only. Rejected App credentials or a
  // request that failed (both `GitHubAppAuthError`) refuse this job and leave the mode and PR ownership alone.
  let installationId: number | null;
  try {
    installationId = await deps.access.installation(app, project.owner, project.name, { strict: true });
  } catch (error) {
    if (error instanceof GitHubAppAuthError) {
      log.warn(`${project.fullName}: GitHub App installation lookup failed: ${error.message}`);
      throw new Refusal("The GitHub App could not be reached or its credentials were rejected. Try again later or ask the administrator to check Admin → GitHub App.");
    }
    throw error;
  }
  if (installationId === null) return loseAccess(`The GitHub App is not installed on ${project.fullName}.`);
  const token = await deps.access.installationToken(app, installationId, project.githubRepoId, "write");
  const octokit = github.createOctokit({ accessToken: token });

  if (!(await ownerHasPermission(prisma, github, octokit, project, user, "write"))) {
    return loseAccess(`You no longer have write access to ${project.fullName}.`);
  }

  // Step 2: default-branch head + tree, the group recomputed from stored rows and fresh registry data.
  let snapshot;
  try {
    snapshot = await github.fetchGitTree({
      owner: project.owner,
      name: project.name,
      repositoryId: project.githubRepoId,
      octokit,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof GitHubRepositoryNotFoundError) throw new Refusal(`${project.fullName} was not found on GitHub.`);
    throw error;
  }
  if (!snapshot.commitSha) throw new Refusal(`${project.fullName} has no commits on its default branch.`);
  const repo = snapshot.repository;
  const reader = createSnapshotReader(
    snapshot.entries,
    (refs, maxBytes) => github.readBlobs(octokit, repo.owner, repo.name, refs, { maxBytes, ...(signal ? { signal } : {}) }),
    deps.blobCache,
  );
  const analysis = await analyzeProject({
    entries: snapshot.entries,
    manifestPaths: project.manifestPaths,
    reader,
    lockCache: deps.lockCache ?? null,
  });

  const [manifestRows, updateRows] = await Promise.all([
    prisma.dependencyManifest.findMany({ where: { projectId: project.id } }),
    prisma.dependencyUpdate.findMany({ where: { projectId: project.id, status: { in: ["OUTDATED", "DISMISSED"] } } }),
  ]);
  const pathById = new Map(manifestRows.map((m) => [m.id, m.path]));
  const outdatedKeys = new Set<string>();
  const dismissed = new Map<string, string>();
  for (const row of updateRows) {
    const path = pathById.get(row.manifestId);
    if (!path) continue;
    const key = rowKey(path, row.name, row.kind, row.group);
    if (row.status === "OUTDATED") outdatedKeys.add(key);
    else if (row.targetVersion) dismissed.set(key, row.targetVersion);
  }
  const isCandidate = (manifest: AnalyzedManifest, d: { dependency: { name: string; kind: string; group: string } }) =>
    outdatedKeys.has(rowKey(manifest.detected.path, d.dependency.name, d.dependency.kind, d.dependency.group));
  const lookups = await lookupRegistries(
    analysis.manifests.flatMap((m) =>
      m.dependencies.filter((d) => d.dependency.supported && isCandidate(m, d)).map((d) => ({ ecosystem: d.ecosystem, name: d.dependency.name })),
    ),
    deps.registry,
    signal,
  );
  const planned = planAnalysis(analysis.manifests, lookups, project, dismissed, now(), isCandidate).filter(
    (item) => item.selection.status === "OUTDATED" && item.selection.targetVersion !== null && item.selection.newDeclared !== null,
  );
  const items: GroupItem[] = planned.map((item) => ({
    ...item,
    name: item.dependency.name,
    manifestPath: item.manifest.detected.path,
    level: item.selection.level,
  }));
  const group = groupUpdates(items, project.groupMode, project.maxOpenPrs).find((candidate) => candidate.groupKey === groupKey);
  if (!group || group.updates.length === 0) return closeEmptyGroup(deps, github, octokit, project, prRow, now);
  if (prRow?.state !== "OPEN" && !group.hasPrSlot) return { status: "SKIPPED", reason: "NO_PR_SLOT" };

  const groupManifests = [...new Map(group.updates.map((u) => [u.manifest.detected.path, u.manifest])).values()];
  const capability = groupCapability(groupManifests.map((m) => m.detected), { lockfileRegeneration: deps.sandbox !== null });
  if (!capability.canCreatePr) throw new Refusal(capability.reason ?? "This group cannot get an update pull request.");

  // Steps 3–4: span edits (hashed requirements get every sha256 of the target), verified by the rewriters.
  const edits = new Map<string, ManifestEdit[]>();
  const skipped: SkippedUpdate[] = [];
  const included: GroupItem[] = [];
  for (const update of group.updates) {
    const { dependency, selection } = update;
    const newDeclared = selection.newDeclared!;
    if (newDeclared === dependency.declared && !manifestNeedsLockfile(update.manifest.detected)) {
      skipped.push({
        name: dependency.name,
        manifestPath: update.manifestPath,
        reason: `the declared range already allows ${selection.targetVersion} and there is no lockfile to update`,
      });
      continue;
    }
    included.push(update);
    if (newDeclared === dependency.declared) continue;
    const list = edits.get(dependency.file) ?? [];
    list.push({
      name: dependency.name,
      kind: dependency.kind,
      group: dependency.group,
      from: dependency.declared,
      to: newDeclared,
      ...("hashes" in dependency && Array.isArray(dependency.hashes) && dependency.hashes.length > 0
        ? { hashes: update.targetRelease?.sha256 ?? [] }
        : {}),
    });
    edits.set(dependency.file, list);
  }
  if (included.length === 0) return closeEmptyGroup(deps, github, octokit, project, prRow, now);

  const changed = new Map<string, string>();
  for (const [file, fileEdits] of edits) {
    const text = await reader.read(file);
    if (text === null) throw new Refusal(`${file} could not be read.`);
    try {
      const name = basename(file);
      const next =
        name === "package.json"
          ? rewritePackageJson(text, fileEdits, file)
          : name === "pyproject.toml"
            ? rewritePyproject(text, fileEdits, file)
            : rewriteRequirements(text, fileEdits, file);
      if (next !== text) changed.set(file, next);
    } catch (error) {
      if (isManifestRewriteError(error)) throw new Refusal(`The manifest could not be updated safely (${error.message}).`);
      throw error;
    }
  }

  // Step 5: lockfiles, regenerated in the sandbox and validated here.
  for (const lockfilePath of capability.lockfiles) {
    const manifests = groupManifests.filter((m) => m.detected.lockfilePath === lockfilePath && manifestNeedsLockfile(m.detected));
    const packageManager = manifests[0]?.detected.packageManager;
    if (!packageManager || !(SANDBOX_PACKAGE_MANAGERS as readonly string[]).includes(packageManager) || !deps.sandbox) {
      throw new Refusal(`${lockfilePath} cannot be regenerated.`);
    }
    const sandboxManager = packageManager as SandboxPackageManager;
    const paths = workspaceFilePaths(snapshot.entries, lockfilePath, sandboxManager);
    if (paths.length > MAX_SANDBOX_FILES) throw new Refusal("The workspace has too many manifests for lockfile regeneration.");
    const small = await reader.readMany(paths.filter((p) => p !== lockfilePath), MAX_MANIFEST_BYTES);
    const lockText = await reader.read(lockfilePath, MAX_LOCKFILE_BYTES);
    if (lockText === null) throw new Refusal(`${lockfilePath} could not be read (larger than 20 MiB?).`);
    const files = paths.flatMap((path) => {
      const content = changed.get(path) ?? (path === lockfilePath ? lockText : small.get(path));
      return content === undefined ? [] : [{ path, contentBase64: Buffer.from(content, "utf8").toString("base64") }];
    });
    const lockUpdates = included.filter((u) => u.manifest.detected.lockfilePath === lockfilePath);
    const upgrade = [...new Map(lockUpdates.map((u) => [`${u.name}@${u.selection.targetVersion}`, { name: u.name, version: u.selection.targetVersion! }])).values()];
    const workdir = dirname(lockfilePath);
    let result: { path: string; text: string };
    try {
      result = await deps.sandbox.lock(
        {
          packageManager: sandboxManager,
          workdir,
          files,
          upgrade,
          lockfileOnly: project.rangeStrategy === "LOCKFILE_ONLY",
          expectLockfile: lockfilePath,
        },
        signal,
      );
      validateLockfile(result, {
        packageManager,
        expectLockfile: lockfilePath,
        inputFormatVersion: manifests[0]!.lockfileFormatVersion,
        importers: manifests.map((manifest) => {
          const planned = new Map(lockUpdates.filter((u) => u.manifest === manifest).map((u) => [u.name, u]));
          return {
            importer: manifest.detected.lockfileImporter,
            ecosystem: manifest.detected.ecosystem,
            dependencies: manifest.dependencies.map((d) => ({
              name: d.dependency.name,
              declared: planned.get(d.dependency.name)?.selection.newDeclared ?? d.dependency.declared,
            })),
            expected: [...planned.values()].map((u) => ({ name: u.name, version: u.selection.targetVersion! })),
          };
        }),
      });
    } catch (error) {
      if (error instanceof SandboxLockError) {
        // The tool's output goes to the job log only, never into the PR or the SSE message.
        if (error.stderrTail) await jobLog(job, `sandbox ${error.code}: ${error.stderrTail.slice(-2048)}`);
        log.warn(`${label}: sandbox ${error.code}`);
        throw new Refusal(error.message);
      }
      throw error;
    }
    if (result.text !== lockText) changed.set(lockfilePath, result.text);
  }

  // Only files whose content differs from the default branch are committed (the bot writes only what it planned).
  const files = [...changed]
    .filter(([path, content]) => reader.sha(path) !== gitBlobSha(content))
    .map(([path, content]) => ({ path, content }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (files.length === 0) return closeEmptyGroup(deps, github, octokit, project, prRow, now);

  const prUpdates: PrUpdate[] = included.map((u) => ({
    ecosystem: u.ecosystem,
    name: u.name,
    manifestPath: u.manifestPath,
    fromVersion: u.selection.currentVersion,
    toVersion: u.selection.targetVersion!,
    level: u.selection.level,
    releasedAt: u.selection.targetReleasedAt,
    sourceRepoUrl: u.sourceRepoUrl,
  }));
  // Every planned target, including no-op ones, so the scan sees the PR as current.
  const targets = buildTargets(
    group.updates.map((u) => ({
      ecosystem: u.ecosystem,
      name: u.name,
      manifestPath: u.manifestPath,
      fromVersion: u.selection.currentVersion,
      toVersion: u.selection.targetVersion!,
      level: u.selection.level,
      releasedAt: u.selection.targetReleasedAt,
      sourceRepoUrl: u.sourceRepoUrl,
    })),
  );
  const prefix = project.commitPrefix.replace(/[\r\n]+/g, " ");
  // Names stay verbatim (`@types/node`): commit messages and PR titles don't notify; the PR body uses code spans.
  const message = buildCommitMessage(prefix, prUpdates);

  // Step 6: the bot branch.
  const branch = depsBranchName(groupKey);
  const intentWhere = { projectId_groupKey: { projectId: project.id, groupKey } };
  const intent = await prisma.dependencyBranchWriteIntent.findUnique({ where: intentWhere });
  let state = await github.inspectBranch(octokit, repo.owner, repo.name, branch, intent?.commitSha ?? prRow?.headSha ?? null);
  // A failed ref write can leave either the saved PR head or an earlier, not-yet-saved bot
  // push in place. Trust only these exact durable SHAs, never other branch content.
  if (state.status === "edited" && (intent?.previousHeadSha === state.headSha || prRow?.headSha === state.headSha)) {
    state = { status: "owned", headSha: state.headSha };
  }
  if (state.status === "edited") {
    if (!prRow) {
      throw new Refusal(`The branch ${branch} already exists and was not created by RepoPulse. Delete it to let RepoPulse open the pull request.`);
    }
    return markEdited(deps, project, prRow, branch);
  }

  let headSha: string;
  const recovered = state.status === "owned" && !!intent && state.headSha !== prRow?.headSha;
  let committed = recovered;
  if (state.status === "owned" && (await github.treeHasContent(octokit, repo.owner, repo.name, state.headSha, files))) {
    headSha = state.headSha;
  } else {
    const commit = await github.commitFiles(octokit, {
      owner: repo.owner,
      repo: repo.name,
      baseSha: snapshot.commitSha,
      branch,
      files,
      message,
      force: state.status === "owned",
      onPrepared: async (commitSha) => {
        const previousHeadSha = state.status === "owned" ? state.headSha : null;
        await prisma.dependencyBranchWriteIntent.upsert({
          where: intentWhere,
          create: { projectId: project.id, groupKey, commitSha, previousHeadSha },
          update: { commitSha, previousHeadSha },
        });
      },
    });
    headSha = commit.commitSha;
    committed = true;
  }

  // Step 7: the pull request.
  const appBaseUrl = deps.appBaseUrl ?? resolveAppBaseUrl();
  const projectUrl = `${appBaseUrl}/dependencies/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const pr = await github.upsertPullRequest(octokit, {
    owner: repo.owner,
    repo: repo.name,
    head: branch,
    base: repo.defaultBranch,
    title: buildPrTitle(prefix, prUpdates),
    body: buildPrBody({ groupKey, updates: prUpdates, skipped, projectUrl }),
    existingNumber: prRow?.state === "OPEN" ? prRow.number : null,
  });

  // Step 8: persist, SSE, notify.
  const at = now();
  const saved = await prisma.dependencyPullRequest.upsert({
    where: { projectId_groupKey: { projectId: project.id, groupKey } },
    create: { projectId: project.id, groupKey, branch, number: pr.number, htmlUrl: pr.htmlUrl, state: "OPEN", headSha, targets, openedAt: at },
    update: {
      branch,
      number: pr.number,
      htmlUrl: pr.htmlUrl,
      state: "OPEN",
      headSha,
      targets,
      closedAt: null,
      ...(pr.created ? { openedAt: at } : {}),
    },
  });
  await prisma.dependencyBranchWriteIntent.deleteMany({
    where: { projectId: project.id, groupKey, OR: [{ commitSha: headSha }, { previousHeadSha: headSha }] },
  });
  await publish(deps.redis, project.userId, {
    type: "DEPS_PULL_REQUEST_UPDATED",
    projectId: project.id,
    fullName: project.fullName,
    groupKey,
    state: "OPEN",
    number: pr.number,
    htmlUrl: pr.htmlUrl,
  });
  const previousTargets = prRow?.state === "OPEN" ? [...prRow.targets].sort().join("\n") : null;
  const newVersions = previousTargets !== targets.join("\n");
  const opened = pr.created || (recovered && !prRow);
  if (opened) await notifyPullRequestEvent(deps, project, saved.id, "opened", headSha);
  else if (committed && newVersions) await notifyPullRequestEvent(deps, project, saved.id, "updated", headSha);

  const status = opened ? "OPENED" : committed ? "UPDATED" : "UNCHANGED";
  log.info(`${label}: PR #${pr.number} ${status.toLowerCase()} (${files.length} file(s), ${included.length} update(s))`);
  return { status, number: pr.number, headSha, files: files.map((f) => f.path) };
}

/** Someone else pushed to the bot branch: `EDITED` (notified once), and the bot never touches the PR again. */
async function markEdited(deps: DepsUpdateDeps, project: ProjectRow, prRow: NonNullable<PrRow>, branch: string): Promise<DepsUpdateOutcome> {
  if (prRow.state !== "EDITED") {
    await deps.prisma.dependencyPullRequest.update({ where: { id: prRow.id }, data: { state: "EDITED" } });
    await publish(deps.redis, project.userId, {
      type: "DEPS_PULL_REQUEST_UPDATED",
      projectId: project.id,
      fullName: project.fullName,
      groupKey: prRow.groupKey,
      state: "EDITED",
      number: prRow.number,
      htmlUrl: prRow.htmlUrl,
    });
    await notifyPullRequestEvent(deps, project, prRow.id, "edited", "edited");
  }
  log.info(`${project.fullName} [${prRow.groupKey}]: someone else pushed to ${branch}; hands off`);
  return { status: "EDITED", number: prRow.number };
}

/**
 * Empty group: close the open PR with a comment (`CLOSED`), or do nothing when there is none. A PR whose branch
 * someone else pushed to is left open and flagged `EDITED` instead (hands off).
 */
async function closeEmptyGroup(
  deps: DepsUpdateDeps,
  github: NonNullable<DepsUpdateDeps["github"]>,
  octokit: Octokit,
  project: ProjectRow,
  prRow: PrRow,
  now: () => Date,
): Promise<DepsUpdateOutcome> {
  if (!prRow || prRow.state !== "OPEN") return { status: "NOTHING_TO_DO" };
  const intent = await deps.prisma.dependencyBranchWriteIntent.findUnique({
    where: { projectId_groupKey: { projectId: project.id, groupKey: prRow.groupKey } },
  });
  const branch = await github.inspectBranch(octokit, project.owner, project.name, prRow.branch, intent?.commitSha ?? prRow.headSha);
  if (branch.status === "edited" && branch.headSha !== prRow.headSha && branch.headSha !== intent?.previousHeadSha) {
    return markEdited(deps, project, prRow, prRow.branch);
  }
  await github.closePullRequest(octokit, { owner: project.owner, repo: project.name, number: prRow.number, comment: EMPTY_GROUP_COMMENT });
  await deps.prisma.dependencyPullRequest.update({ where: { id: prRow.id }, data: { state: "CLOSED", closedAt: now() } });
  await publish(deps.redis, project.userId, {
    type: "DEPS_PULL_REQUEST_UPDATED",
    projectId: project.id,
    fullName: project.fullName,
    groupKey: prRow.groupKey,
    state: "CLOSED",
    number: prRow.number,
    htmlUrl: prRow.htmlUrl,
  });
  log.info(`${project.fullName} [${prRow.groupKey}]: group is empty; closed PR #${prRow.number}`);
  return { status: "CLOSED", number: prRow.number };
}
