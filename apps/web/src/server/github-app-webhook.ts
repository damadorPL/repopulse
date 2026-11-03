import { verifyWebhookSignature } from "@repopulse/github";

/**
 * GitHub App webhooks (Slice 08 Part E): the logic behind `POST /api/github-app/webhook`, kept free
 * of Next.js and of concrete database / Redis clients so it can be unit-tested with fakes.
 *
 * Webhooks only speed things up: polling (the `deps-scheduler`) stays the fallback, so every failure
 * here is harmless. The handler never writes to the database; it only enqueues `deps-scan` jobs.
 * Not a `"use server"` module: nothing here is callable from the browser.
 */

/** Largest accepted delivery (GitHub caps payloads at 25 MB; a push with many commits is far smaller). */
export const WEBHOOK_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** GitHub's push payload lists at most this many commits; a list this long may be truncated. */
export const PUSH_MAX_LISTED_COMMITS = 2048;

/** Branch prefix of the bot's update pull requests (`repopulse/deps/<groupKey>`). */
export const DEPS_BRANCH_PREFIX = "repopulse/deps/";

export class PayloadTooLargeError extends Error {
  constructor() {
    super(`The webhook payload is larger than ${WEBHOOK_MAX_BODY_BYTES} bytes.`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Reads a request body into a Buffer, counting bytes as they arrive: more than `limit` bytes cancels
 * the stream and throws {@link PayloadTooLargeError}, so an oversized body is never buffered whole.
 */
export async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, limit = WEBHOOK_MAX_BODY_BYTES): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

const LOCK_AND_MANIFEST_FILES: ReadonlySet<string> = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
]);

/**
 * A path whose change can change a dependency project's scan result: npm / Bun / Yarn / pnpm and
 * Python manifests, lockfiles and pip-tools sources. Mirrors what `@repopulse/deps` detects.
 */
export function isDependencyFilePath(path: string): boolean {
  const segments = path.split("/");
  const file = segments.at(-1)?.toLowerCase() ?? "";
  if (LOCK_AND_MANIFEST_FILES.has(file)) return true;
  if (/^(?:requirements|constraints).*\.txt$/.test(file)) return true;
  if (file.endsWith(".txt") && segments.at(-2)?.toLowerCase() === "requirements") return true;
  return file.endsWith(".in");
}

interface PushCommit {
  added?: unknown;
  modified?: unknown;
  removed?: unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The files a push changed, or `null` when GitHub's list may be incomplete (no commit list, an empty
 * one for a push that moved the branch, e.g. a force-push to an older commit, or a list at GitHub's cap).
 */
export function changedPathsOfPush(payload: { commits?: unknown }): Set<string> | null {
  const commits = payload.commits;
  if (!Array.isArray(commits) || commits.length === 0 || commits.length >= PUSH_MAX_LISTED_COMMITS) return null;
  const paths = new Set<string>();
  for (const commit of commits as PushCommit[]) {
    if (!commit || typeof commit !== "object") return null;
    for (const path of [...stringList(commit.added), ...stringList(commit.modified), ...stringList(commit.removed)]) paths.add(path);
  }
  return paths;
}

/** Whether a push touched a dependency file of a project (generic manifests / lockfiles, or its explicit paths). */
export function pushTouchesProject(changed: Set<string> | null, manifestPaths: readonly string[]): boolean {
  if (changed === null) return true;
  for (const path of changed) {
    if (isDependencyFilePath(path) || manifestPaths.includes(path)) return true;
  }
  return false;
}

export interface WebhookAppSettings {
  /** Admin → Dependencies switch. */
  depsEnabled: boolean;
  /** `null` when no GitHub App is saved. */
  app: { webhookSecret: string | null } | null;
}

export interface WebhookProject {
  id: string;
  manifestPaths: string[];
}

export interface WebhookDeps {
  /** Throws `GitHubAppKeyUnreadableError` when the stored secret can't be decrypted. */
  loadSettings(): Promise<WebhookAppSettings>;
  /** Every project (any user) of this GitHub repository whose stored default branch is `branch`. */
  findProjectsOnBranch(githubRepoId: number, branch: string): Promise<WebhookProject[]>;
  /** The project that owns update PRs on this repository (`DependencyPrOwner`), if any. */
  findPrOwnerProjectId(githubRepoId: number): Promise<string | null>;
  /** Enqueues a `deps-scan` with `trigger: "webhook"` (deduplicated by jobId). */
  enqueueScan(projectId: string): Promise<void>;
}

export interface WebhookRequest {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export interface WebhookResult {
  status: number;
  /** Small JSON body (shown in GitHub's "Recent deliveries"); none for 204. */
  body?: Record<string, unknown>;
}

const noContent = (): WebhookResult => ({ status: 204 });

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Project ids to rescan for a verified delivery (empty = nothing to do). */
export async function projectsToScan(event: string, payload: Record<string, unknown>, deps: WebhookDeps): Promise<string[]> {
  const repoId = positiveInt(asRecord(payload.repository)?.id);
  if (repoId === null) return [];

  if (event === "push") {
    const ref = payload.ref;
    if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || payload.deleted === true) return [];
    const branch = ref.slice("refs/heads/".length);
    const projects = await deps.findProjectsOnBranch(repoId, branch);
    if (projects.length === 0) return [];
    const changed = changedPathsOfPush(payload);
    return projects.filter((project) => pushTouchesProject(changed, project.manifestPaths)).map((project) => project.id);
  }

  if (event === "pull_request") {
    if (payload.action !== "closed") return [];
    const headRef = asRecord(asRecord(payload.pull_request)?.head)?.ref;
    if (typeof headRef !== "string" || !headRef.startsWith(DEPS_BRANCH_PREFIX)) return [];
    const projectId = await deps.findPrOwnerProjectId(repoId);
    return projectId ? [projectId] : [];
  }

  return [];
}

/**
 * Handles one delivery. Order: size cap (413), App and secret configured (404 / 503), signature
 * (401), module enabled, then the event. Never throws for bad input; infrastructure errors (database,
 * Redis) propagate to the route, which answers 503.
 */
export async function handleGitHubAppWebhook(request: WebhookRequest, deps: WebhookDeps): Promise<WebhookResult> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > WEBHOOK_MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => {});
    return { status: 413, body: { error: "payload too large" } };
  }

  let rawBody: Buffer;
  try {
    rawBody = await readBodyWithLimit(request.body);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return { status: 413, body: { error: "payload too large" } };
    throw error;
  }

  const settings = await deps.loadSettings();
  if (!settings.app) return { status: 404, body: { error: "no GitHub App is configured" } };
  const secret = settings.app.webhookSecret;
  if (!secret) return { status: 503, body: { error: "no webhook secret is configured" } };
  if (!verifyWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"), secret)) {
    return { status: 401, body: { error: "invalid signature" } };
  }

  if (!settings.depsEnabled) return noContent();
  const event = request.headers.get("x-github-event") ?? "";
  if (event !== "push" && event !== "pull_request") return noContent();

  let payload: Record<string, unknown> | null;
  try {
    payload = asRecord(JSON.parse(rawBody.toString("utf8")));
  } catch {
    return { status: 400, body: { error: "the payload is not JSON" } };
  }
  if (!payload) return { status: 400, body: { error: "the payload is not a JSON object" } };

  const projectIds = await projectsToScan(event, payload, deps);
  if (projectIds.length === 0) return noContent();
  await Promise.all(projectIds.map((id) => deps.enqueueScan(id)));
  return { status: 202, body: { queued: projectIds.length } };
}
