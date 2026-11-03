import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { getRateLimitInfo, isGitHubHttpError, type ResponseHeaders } from "./client.js";
import { GitHubRateLimitError } from "./poller.js";

/**
 * Git Data API helpers for dependency update pull requests (Slice 08, §3.9). Used by `deps-worker`
 * with an installation-token Octokit narrowed to one repository. Commits carry no author / committer
 * fields, so GitHub attributes them to `<app-slug>[bot]` and signs them.
 */

/** Concurrent requests per helper call (blob reads / writes). GitHub's secondary limits punish bursts. */
export const GIT_WRITE_CONCURRENCY = 4;

/** A ref create / update lost a race (409 / 422): someone pushed, or the branch appeared / vanished. */
export class RefUpdateConflictError extends Error {
  readonly status: number;
  readonly ref: string;

  constructor(ref: string, status: number, detail?: string) {
    super(`Updating ${ref} conflicted with a concurrent change (HTTP ${status}${detail ? `: ${detail}` : ""}).`);
    this.name = "RefUpdateConflictError";
    this.status = status;
    this.ref = ref;
  }
}

function headerString(headers: ResponseHeaders | undefined, name: string): string | null {
  const raw = headers?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value === null || value === "" ? null : String(value);
}

/**
 * The rate-limit error for a primary (`x-ratelimit-remaining: 0`, 429) or secondary (`retry-after`)
 * GitHub rate limit, or `null` for any other error.
 */
export function toRateLimitError(error: unknown): GitHubRateLimitError | null {
  if (!isGitHubHttpError(error) || (error.status !== 403 && error.status !== 429)) return null;
  const headers = error.response?.headers;
  const rateLimit = getRateLimitInfo(headers);
  const retryAfter = Number(headerString(headers, "retry-after"));
  if (rateLimit.remaining === 0) return new GitHubRateLimitError(rateLimit.resetAt);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return new GitHubRateLimitError(new Date(Date.now() + retryAfter * 1000));
  return error.status === 429 ? new GitHubRateLimitError(rateLimit.resetAt) : null;
}

/** Throws {@link toRateLimitError} for rate limits (like the poller), else re-throws the error unchanged. */
export function rethrowRateLimit(error: unknown): never {
  throw toRateLimitError(error) ?? error;
}

function errorMessage(error: unknown): string | undefined {
  if (!isGitHubHttpError(error)) return undefined;
  const data = (error as { response?: { data?: unknown } }).response?.data;
  const message = data && typeof data === "object" ? (data as { message?: unknown }).message : undefined;
  return typeof message === "string" ? message.slice(0, 200) : undefined;
}

/** Runs `fn` over `items` with at most `limit` promises in flight; results keep the input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function toBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

/** The Git object id of a blob: `sha1("blob <byte length>\0" + content)`. */
export function gitBlobSha(content: string | Uint8Array): string {
  const bytes = toBuffer(content);
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

// ─── Reading ───────────────────────────────────────────────────────────────

export interface BlobRef {
  path: string;
  sha: string;
  /** Size from the tree listing, when known: oversize blobs are then skipped without a request. */
  size?: number | null;
}

export interface ReadBlobResult {
  path: string;
  sha: string;
  size: number | null;
  /** UTF-8 content; `null` when the blob is larger than `maxBytes`. */
  content: string | null;
  oversize: boolean;
}

/**
 * `GET /repos/{o}/{r}/git/blobs/{sha}` for each entry (base64 decoded as UTF-8), at most
 * `concurrency` at a time. Blobs over `maxBytes` are flagged `oversize` with `content: null`.
 * Results keep the input order.
 */
export async function readBlobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  entries: readonly BlobRef[],
  options: { maxBytes: number; concurrency?: number; signal?: AbortSignal },
): Promise<ReadBlobResult[]> {
  const request = options.signal ? { request: { signal: options.signal } } : {};
  return mapLimit(entries, options.concurrency ?? GIT_WRITE_CONCURRENCY, async (entry) => {
    const known = typeof entry.size === "number" ? entry.size : null;
    if (known !== null && known > options.maxBytes) {
      return { path: entry.path, sha: entry.sha, size: known, content: null, oversize: true };
    }
    try {
      const response = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner,
        repo,
        file_sha: entry.sha,
        ...request,
      });
      const data = response.data as { content?: string; encoding?: string; size?: number | null };
      const raw = data.content ?? "";
      const bytes = data.encoding === "base64" ? Buffer.from(raw, "base64") : Buffer.from(raw, "utf8");
      const size = typeof data.size === "number" ? data.size : bytes.byteLength;
      if (size > options.maxBytes || bytes.byteLength > options.maxBytes) {
        return { path: entry.path, sha: entry.sha, size, content: null, oversize: true };
      }
      return { path: entry.path, sha: entry.sha, size, content: bytes.toString("utf8"), oversize: false };
    } catch (error) {
      rethrowRateLimit(error);
    }
  });
}

/** The commit SHA at the tip of `branch`, or `null` when the branch doesn't exist (or the repository is empty). */
export async function getBranchHead(octokit: Octokit, owner: string, repo: string, branch: string): Promise<string | null> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: `heads/${branch}` });
    const data = response.data as { ref?: string; object?: { sha?: string } };
    // A missing ref can answer with a prefix match list on some API versions; only accept an exact ref.
    if (data.ref !== undefined && data.ref !== `refs/heads/${branch}`) return null;
    return data.object?.sha ?? null;
  } catch (error) {
    if (isGitHubHttpError(error) && (error.status === 404 || error.status === 409)) return null;
    rethrowRateLimit(error);
  }
}

export type BranchOwnership =
  | { status: "missing" }
  | { status: "owned"; headSha: string }
  | { status: "edited"; headSha: string };

/**
 * Whether the bot may rewrite `branch`: `owned` when its head is the commit we pushed last
 * (`expectedHeadSha`), `edited` when anyone pushed since, `missing` when it doesn't exist.
 */
export async function inspectBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  expectedHeadSha: string | null | undefined,
): Promise<BranchOwnership> {
  const headSha = await getBranchHead(octokit, owner, repo, branch);
  if (headSha === null) return { status: "missing" };
  return expectedHeadSha && headSha === expectedHeadSha ? { status: "owned", headSha } : { status: "edited", headSha };
}

/** `true` when the branch exists and its head is `expectedHeadSha` (our last commit). A missing branch is `false`. */
export async function branchIsBotOwned(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  expectedHeadSha: string | null | undefined,
): Promise<boolean> {
  return (await inspectBranch(octokit, owner, repo, branch, expectedHeadSha)).status === "owned";
}

export interface FileContent {
  path: string;
  content: string | Uint8Array;
}

interface TreeEntry {
  path?: string;
  type?: string;
  sha?: string | null;
}

/** Pure: every file's blob SHA equals the tree entry at its path (blobs only). */
export function treeMatchesFiles(tree: readonly TreeEntry[], files: readonly FileContent[]): boolean {
  const byPath = new Map<string, string>();
  for (const entry of tree) {
    if (entry.path && entry.type === "blob" && entry.sha) byPath.set(entry.path, entry.sha);
  }
  return files.every((file) => byPath.get(file.path) === gitBlobSha(file.content));
}

/**
 * Whether the tree of `commitSha` (a branch head) already holds exactly `files` at their paths,
 * compared by blob SHA computed locally. One request (`GET git/trees/{sha}?recursive=1`). A truncated
 * tree that lacks a path answers `false` (the caller then just commits again).
 */
export async function treeHasContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  commitSha: string,
  files: readonly FileContent[],
): Promise<boolean> {
  if (files.length === 0) return true;
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: commitSha,
      recursive: "1",
    });
    return treeMatchesFiles((response.data as { tree?: TreeEntry[] }).tree ?? [], files);
  } catch (error) {
    if (isGitHubHttpError(error) && (error.status === 404 || error.status === 409)) return false;
    rethrowRateLimit(error);
  }
}

// ─── Writing ───────────────────────────────────────────────────────────────

export interface CommitFilesParams {
  owner: string;
  repo: string;
  /** Parent commit (the default branch head); its tree is the `base_tree`. */
  baseSha: string;
  /** Branch name without `refs/heads/`. */
  branch: string;
  files: ReadonlyArray<FileContent & { mode?: "100644" | "100755" }>;
  message: string;
  /** `true`: force-update the branch (created when missing). `false`: create it; an existing branch is a conflict. */
  force: boolean;
}

export interface CommitFilesResult {
  commitSha: string;
  treeSha: string;
}

/**
 * Blobs → tree (`base_tree` = the base commit's tree) → commit (single parent `baseSha`, no
 * author / committer, so the App's bot is the author) → create or force-update `refs/heads/<branch>`.
 * A 409 / 422 from the ref write throws {@link RefUpdateConflictError}.
 */
export async function commitFiles(octokit: Octokit, params: CommitFilesParams): Promise<CommitFilesResult> {
  const { owner, repo, baseSha, branch, files, message } = params;
  if (files.length === 0) throw new Error("commitFiles needs at least one file.");
  const ref = `heads/${branch}`;

  let commitSha: string;
  let treeSha: string;
  try {
    const base = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: baseSha });
    const baseTree = base.data.tree.sha;

    const blobs = await mapLimit(files, GIT_WRITE_CONCURRENCY, async (file) => {
      const response = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner,
        repo,
        content: toBuffer(file.content).toString("base64"),
        encoding: "base64",
      });
      return response.data.sha;
    });

    const tree = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
      owner,
      repo,
      base_tree: baseTree,
      tree: files.map((file, index) => ({
        path: file.path,
        mode: file.mode ?? "100644",
        type: "blob" as const,
        sha: blobs[index] as string,
      })),
    });
    treeSha = tree.data.sha;

    const commit = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner,
      repo,
      message,
      tree: treeSha,
      parents: [baseSha],
    });
    commitSha = commit.data.sha;
  } catch (error) {
    rethrowRateLimit(error);
  }

  await writeRef(octokit, owner, repo, ref, commitSha, params.force);
  return { commitSha, treeSha };
}

async function createRef(octokit: Octokit, owner: string, repo: string, ref: string, sha: string): Promise<void> {
  try {
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo, ref: `refs/${ref}`, sha });
  } catch (error) {
    if (isGitHubHttpError(error) && (error.status === 409 || error.status === 422)) {
      throw new RefUpdateConflictError(`refs/${ref}`, error.status, errorMessage(error));
    }
    rethrowRateLimit(error);
  }
}

async function writeRef(octokit: Octokit, owner: string, repo: string, ref: string, sha: string, force: boolean): Promise<void> {
  if (!force) return createRef(octokit, owner, repo, ref, sha);
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo, ref, sha, force: true });
  } catch (error) {
    if (isGitHubHttpError(error) && (error.status === 409 || error.status === 422)) {
      const detail = errorMessage(error);
      // The branch is gone (deleted after the PR closed): create it instead.
      if (error.status === 422 && detail && /does not exist/i.test(detail)) return createRef(octokit, owner, repo, ref, sha);
      throw new RefUpdateConflictError(`refs/${ref}`, error.status, detail);
    }
    rethrowRateLimit(error);
  }
}

// ─── Pull requests ─────────────────────────────────────────────────────────

export interface UpsertPullRequestParams {
  owner: string;
  repo: string;
  /** Branch name in the same repository (no `owner:` prefix). */
  head: string;
  base: string;
  title: string;
  body: string;
  /** The PR we opened before; reused while it is open. */
  existingNumber?: number | null;
}

export interface PullRequestRef {
  number: number;
  htmlUrl: string;
  state: "open" | "closed";
  /** `true` when this call opened a new pull request. */
  created: boolean;
}

interface PullData {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean | null;
  merged_at?: string | null;
  head: { sha: string; ref: string };
}

function toRef(data: PullData, created: boolean): PullRequestRef {
  return { number: data.number, htmlUrl: data.html_url, state: data.state === "open" ? "open" : "closed", created };
}

async function findOpenPullRequest(octokit: Octokit, owner: string, repo: string, head: string, base: string): Promise<PullData | null> {
  const response = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    head: `${owner}:${head}`,
    base,
    state: "open",
    per_page: 10,
  });
  return ((response.data as PullData[])[0] ?? null) as PullData | null;
}

/**
 * Opens or refreshes the PR for `head` → `base`: the `existingNumber` PR when it is still open,
 * else an open PR found by head branch, else a new one. Title and body are rewritten on update.
 */
export async function upsertPullRequest(octokit: Octokit, params: UpsertPullRequestParams): Promise<PullRequestRef> {
  const { owner, repo, head, base, title, body } = params;
  try {
    let existing: PullData | null = null;
    if (params.existingNumber) {
      try {
        const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner,
          repo,
          pull_number: params.existingNumber,
        });
        const data = response.data as PullData;
        if (data.state === "open" && data.head.ref === head) existing = data;
      } catch (error) {
        if (!(isGitHubHttpError(error) && error.status === 404)) throw error;
      }
    }
    existing ??= await findOpenPullRequest(octokit, owner, repo, head, base);

    if (existing) {
      const updated = await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: existing.number,
        title,
        body,
      });
      return toRef(updated.data as PullData, false);
    }

    try {
      const created = await octokit.request("POST /repos/{owner}/{repo}/pulls", { owner, repo, head, base, title, body });
      return toRef(created.data as PullData, true);
    } catch (error) {
      // "A pull request already exists for owner:head": opened concurrently; update that one.
      if (isGitHubHttpError(error) && error.status === 422) {
        const raced = await findOpenPullRequest(octokit, owner, repo, head, base);
        if (raced) {
          const updated = await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
            owner,
            repo,
            pull_number: raced.number,
            title,
            body,
          });
          return toRef(updated.data as PullData, false);
        }
      }
      throw error;
    }
  } catch (error) {
    rethrowRateLimit(error);
  }
}

/**
 * Comments (PR comments go through the issues endpoint, which `pull_requests: write` covers for
 * pull requests) and closes the PR. The branch is left in place.
 */
export async function closePullRequest(
  octokit: Octokit,
  params: { owner: string; repo: string; number: number; comment?: string | null },
): Promise<void> {
  const { owner, repo, number } = params;
  try {
    if (params.comment) {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: number,
        body: params.comment,
      });
    }
    await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number, state: "closed" });
  } catch (error) {
    rethrowRateLimit(error);
  }
}

export interface PullRequestState {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  headRef: string;
}

/** `GET /repos/{o}/{r}/pulls/{n}`. `null` when the PR (or access to the repository) is gone (404). */
export async function getPullRequestState(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestState | null> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
    const data = response.data as PullData;
    return {
      state: data.state === "open" ? "open" : "closed",
      merged: data.merged === true || Boolean(data.merged_at),
      headSha: data.head.sha,
      headRef: data.head.ref,
    };
  } catch (error) {
    if (isGitHubHttpError(error) && error.status === 404) return null;
    rethrowRateLimit(error);
  }
}
