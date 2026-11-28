import type { Octokit } from "@octokit/rest";

import { createOctokit, isGitHubHttpError } from "./client.js";
import { hasNextLink, rethrowGitHubError } from "./poller.js";
import { subjectOf } from "./tags.js";
import { commitMatchesPath } from "./watched-paths.js";

/** Newest commits read per watched path per poll ("Files / folders", Slice 06). */
const PATH_COMMITS_PAGE_SIZE = 10;
/** Changed files listed in a commit changelog before "…and N more files". */
export const COMMIT_CHANGELOG_MAX_FILES = 50;
/** GitHub returns at most this many files per commit detail page. */
const COMMIT_DETAIL_FILES_PAGE_SIZE = 300;

/** A commit from `GET /repos/{owner}/{repo}/commits?path=…`. */
export interface PathCommitSummary {
  sha: string;
  htmlUrl: string;
  /** Full commit message (subject + body). */
  message: string;
  /** Committer date: when the commit landed (the author date can be much older after a rebase). */
  committedDate: Date;
  authorName: string | null;
  /** GitHub account of the author, when the commit email is linked to one. */
  authorLogin: string | null;
}

export interface CommitFileChange {
  filename: string;
  /** GitHub's status: `added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged`. */
  status: string;
  additions: number;
  deletions: number;
  /** Renamed files only. */
  previousFilename?: string;
}

/** A commit from `GET /repos/{owner}/{repo}/commits/{ref}`. */
export interface CommitDetail {
  sha: string;
  stats: { additions: number; deletions: number; total: number };
  /** First page only (GitHub caps it at 300 files). */
  files: CommitFileChange[];
  /** GitHub has more files than `files` holds. */
  filesTruncated?: boolean;
}

/** A commit in the `Release` row shape (`source = COMMIT`). */
export interface MappedPathCommit {
  source: "COMMIT";
  githubReleaseId: null;
  /** Full SHA. */
  tagSha: string;
  /** 7-character short SHA. */
  tagName: string;
  title: string;
  bodyMarkdown: string;
  htmlUrl: string;
  isPrerelease: false;
  isDraft: false;
  semverType: "OTHER";
  publishedAt: Date;
  changedPaths: string[];
}

interface CommitListItem {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string | null; date?: string | null } | null;
    committer: { name?: string | null; date?: string | null } | null;
  };
  author: { login: string } | null;
}

interface CommitDetailData {
  sha: string;
  stats?: { additions?: number; deletions?: number; total?: number };
  files?: Array<{ filename: string; status: string; additions: number; deletions: number; previous_filename?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCommitAuthorBlock(raw: unknown): { name?: string | null; date?: string | null } | null {
  if (!isRecord(raw)) return null;
  return {
    name: typeof raw.name === "string" ? raw.name : null,
    date: typeof raw.date === "string" ? raw.date : null,
  };
}

function parseCommitList(raw: unknown): CommitListItem[] {
  if (!Array.isArray(raw)) return [];
  const items: CommitListItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.sha !== "string" || typeof entry.html_url !== "string") continue;
    const commit = isRecord(entry.commit) ? entry.commit : {};
    items.push({
      sha: entry.sha,
      html_url: entry.html_url,
      commit: {
        message: typeof commit.message === "string" ? commit.message : "",
        author: parseCommitAuthorBlock(commit.author),
        committer: parseCommitAuthorBlock(commit.committer),
      },
      author: isRecord(entry.author) && typeof entry.author.login === "string" ? { login: entry.author.login } : null,
    });
  }
  return items;
}

function parseCommitDetail(raw: unknown): CommitDetailData {
  if (!isRecord(raw) || typeof raw.sha !== "string") {
    throw new Error("GitHub returned an unexpected commit detail payload.");
  }
  const files: CommitDetailData["files"] = [];
  if (Array.isArray(raw.files)) {
    for (const file of raw.files) {
      if (
        !isRecord(file) ||
        typeof file.filename !== "string" ||
        typeof file.status !== "string" ||
        typeof file.additions !== "number" ||
        typeof file.deletions !== "number"
      ) {
        continue;
      }
      files.push({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(typeof file.previous_filename === "string" ? { previous_filename: file.previous_filename } : {}),
      });
    }
  }
  const stats = isRecord(raw.stats)
    ? {
        ...(typeof raw.stats.additions === "number" ? { additions: raw.stats.additions } : {}),
        ...(typeof raw.stats.deletions === "number" ? { deletions: raw.stats.deletions } : {}),
        ...(typeof raw.stats.total === "number" ? { total: raw.stats.total } : {}),
      }
    : undefined;
  return { sha: raw.sha, ...(stats ? { stats } : {}), files };
}

function requestOptions(signal: AbortSignal | undefined) {
  return signal ? { request: { signal } } : {};
}

/** Maps one item of the commits list. */
export function mapCommitListItem(item: CommitListItem): PathCommitSummary {
  const date = item.commit.committer?.date ?? item.commit.author?.date;
  const authorTrimmed = item.commit.author?.name?.trim();
  return {
    sha: item.sha,
    htmlUrl: item.html_url,
    message: item.commit.message,
    committedDate: date ? new Date(date) : new Date(0),
    authorName: authorTrimmed !== undefined && authorTrimmed.length > 0 ? authorTrimmed : null,
    authorLogin: item.author?.login ?? null,
  };
}

/**
 * The newest commits on the default branch that touch `path` (a file, or anything inside a
 * folder), newest first. Works anonymously, but a token gets the larger quota.
 */
export async function fetchCommitsForPath(params: {
  owner: string;
  name: string;
  path: string;
  first?: number;
  since?: string;
  etag?: string | null;
  onEtag?: (etag: string | null) => void;
  accessToken?: string | null;
  octokit?: Octokit;
  signal?: AbortSignal;
}): Promise<PathCommitSummary[]> {
  const { owner, name, path, first = PATH_COMMITS_PAGE_SIZE } = params;
  const octokit = params.octokit ?? createOctokit({ accessToken: params.accessToken });
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner,
      repo: name,
      path,
      per_page: first,
      ...(params.since ? { since: params.since } : {}),
      ...(params.etag ? { headers: { "If-None-Match": params.etag } } : {}),
      ...requestOptions(params.signal),
    });
    const etag = typeof response.headers.etag === "string" ? response.headers.etag : null;
    params.onEtag?.(etag);
    return parseCommitList(response.data).map(mapCommitListItem);
  } catch (error) {
    if (isGitHubHttpError(error) && error.status === 304) return [];
    // 409 "Git Repository is empty": no commits yet.
    if (isGitHubHttpError(error) && error.status === 409) return [];
    rethrowGitHubError(error, owner, name);
  }
}

/** The files and line counts of one commit (`GET /repos/{owner}/{repo}/commits/{ref}`). */
export async function fetchCommitDetail(params: {
  owner: string;
  name: string;
  ref: string;
  accessToken?: string | null;
  octokit?: Octokit;
  signal?: AbortSignal;
}): Promise<CommitDetail> {
  const { owner, name, ref } = params;
  const octokit = params.octokit ?? createOctokit({ accessToken: params.accessToken });
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo: name,
      ref,
      per_page: COMMIT_DETAIL_FILES_PAGE_SIZE,
      ...requestOptions(params.signal),
    });
    const data = parseCommitDetail(response.data);
    const files = (data.files ?? []).map((file) => {
      const entry: CommitFileChange = {
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      };
      if (file.previous_filename) entry.previousFilename = file.previous_filename;
      return entry;
    });
    const linkHeader = typeof response.headers.link === "string" ? response.headers.link : undefined;
    return {
      sha: data.sha,
      stats: {
        additions: data.stats?.additions ?? 0,
        deletions: data.stats?.deletions ?? 0,
        total: data.stats?.total ?? 0,
      },
      files,
      filesTruncated: hasNextLink(linkHeader),
    };
  } catch (error) {
    rethrowGitHubError(error, owner, name);
  }
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Inline code that survives backticks in the text. */
function code(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = longestRun > 0 ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Everything after the subject line, trimmed. */
function bodyOf(message: string): string {
  const newline = message.search(/\r?\n/);
  return newline === -1 ? "" : message.slice(newline).replace(/\r\n?/g, "\n").trim();
}

function fileLine(file: CommitFileChange): string {
  const notes: string[] = [`+${file.additions} / -${file.deletions}`];
  if (file.status === "added") notes.push("added");
  else if (file.status === "removed") notes.push("removed");
  else if (file.status === "renamed" && file.previousFilename)
    notes.push(`renamed from ${code(file.previousFilename)}`);
  return `- ${code(file.filename)} (${notes.join(", ")})`;
}

function touchesAny(file: CommitFileChange, watchedPaths: readonly string[]): boolean {
  return watchedPaths.some(
    (watched) =>
      commitMatchesPath(file.filename, watched) ||
      (file.previousFilename !== undefined && commitMatchesPath(file.previousFilename, watched)),
  );
}

/**
 * Markdown changelog of a commit: the message body, the author, the changed files with line counts
 * (files under the watched paths first, capped at {@link COMMIT_CHANGELOG_MAX_FILES}) and the commit
 * link. Without `detail` (the request failed), the watched paths it was found through instead.
 */
export function buildCommitChangelog(
  commit: PathCommitSummary,
  detail: CommitDetail | null,
  matchedPaths: readonly string[],
): string {
  const parts: string[] = [];
  const body = bodyOf(commit.message);
  if (body) parts.push(body);

  const author = commit.authorLogin
    ? `**@${commit.authorLogin}**`
    : commit.authorName
      ? `**${commit.authorName}**`
      : null;
  if (author) parts.push(`Committed by ${author}`);

  const link = `[View commit ${code(commit.sha.slice(0, 7))} on GitHub](${commit.htmlUrl})`;
  if (detail) {
    // Stable sort: files under the watched paths first, otherwise GitHub's order.
    const files = detail.files.toSorted(
      (a, b) => Number(touchesAny(b, matchedPaths)) - Number(touchesAny(a, matchedPaths)),
    );
    const shown = files.slice(0, COMMIT_CHANGELOG_MAX_FILES);
    const lines = shown.map(fileLine);
    const hidden = files.length - shown.length;
    if (hidden > 0 || detail.filesTruncated) {
      lines.push(detail.filesTruncated ? "- …and more files" : `- …and ${plural(hidden, "more file")}`);
    }
    const fileCount = detail.filesTruncated
      ? `${files.length}+ files changed`
      : `${plural(files.length, "file")} changed`;
    parts.push(
      "### Changed files",
      lines.length > 0 ? lines.join("\n") : "_No file changes listed._",
      `${link} · ${fileCount} (+${detail.stats.additions} / -${detail.stats.deletions})`,
    );
  } else {
    parts.push("### Watched paths", matchedPaths.map((path) => `- ${code(path)}`).join("\n") || "_None._", link);
  }
  return parts.join("\n\n");
}

/**
 * Maps a commit to the `Release` row shape. `changedPaths` holds every changed file (renames:
 * both names) plus the watched paths the commit was found through, so it still matches them when
 * the file list is missing or truncated.
 */
export function mapPathCommit(
  commit: PathCommitSummary,
  detail: CommitDetail | null,
  matchedPaths: readonly string[],
): MappedPathCommit {
  const tagName = commit.sha.slice(0, 7);
  const changed = (detail?.files ?? []).flatMap((file) =>
    file.previousFilename ? [file.filename, file.previousFilename] : [file.filename],
  );
  return {
    source: "COMMIT",
    githubReleaseId: null,
    tagSha: commit.sha,
    tagName,
    title: subjectOf(commit.message) || tagName,
    bodyMarkdown: buildCommitChangelog(commit, detail, matchedPaths),
    htmlUrl: commit.htmlUrl,
    isPrerelease: false,
    isDraft: false,
    semverType: "OTHER",
    publishedAt: commit.committedDate,
    changedPaths: [...new Set([...changed, ...matchedPaths])],
  };
}
