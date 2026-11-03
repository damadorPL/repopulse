/**
 * Update pull request texts (Slice 08 §3.9 steps 6–7): branch name, commit message / title, Markdown body and the
 * `targets` strings stored on `DependencyPullRequest`. Commit messages and PR titles keep dependency names verbatim
 * (GitHub does not notify for `@scope/name` there); the PR body, which does render mentions, puts every name in a
 * code span and defuses `@` in free text.
 */
import { DEPS_BRANCH_PREFIX } from "./limits.js";
import { isValidGroupKey } from "./plan.js";
import type { DependencyEcosystem, SemverType } from "./types.js";

/** GitHub rejects PR bodies above 65,536 characters; keep a margin. */
export const PR_BODY_MAX_LENGTH = 60_000;

/** `repopulse/deps/<groupKey>`. Throws on an invalid key (`[a-z0-9-]` only). */
export function depsBranchName(groupKey: string): string {
  if (!isValidGroupKey(groupKey)) throw new Error(`invalid group key ${JSON.stringify(groupKey)}`);
  return `${DEPS_BRANCH_PREFIX}${groupKey}`;
}

/** Group key of a bot branch (`refs/heads/` prefix allowed), or `null`. */
export function groupKeyFromBranch(branch: string): string | null {
  const name = branch.replace(/^refs\/heads\//, "");
  if (!name.startsWith(DEPS_BRANCH_PREFIX)) return null;
  const key = name.slice(DEPS_BRANCH_PREFIX.length);
  return isValidGroupKey(key) ? key : null;
}

/** Hidden marker at the end of the PR body: `<!-- repopulse:deps:<groupKey> -->`. */
export function depsPrMarker(groupKey: string): string {
  return `<!-- repopulse:deps:${groupKey} -->`;
}

/** Group key from a PR body's marker, or `null`. */
export function parseDepsPrMarker(body: string | null | undefined): string | null {
  const match = /<!-- repopulse:deps:([a-z0-9-]+) -->/.exec(body ?? "");
  return match?.[1] ?? null;
}

export interface PrUpdate {
  ecosystem: DependencyEcosystem;
  name: string;
  manifestPath: string;
  /** Current version (lockfile / pin / lower bound), or `null` when unknown. */
  fromVersion: string | null;
  toVersion: string;
  level: SemverType | null;
  releasedAt: Date | null;
  sourceRepoUrl: string | null;
}

/** `"manifestPath#name@version"`, stored in `DependencyPullRequest.targets`. */
export function formatTarget(update: Pick<PrUpdate, "manifestPath" | "name" | "toVersion">): string {
  return `${update.manifestPath}#${update.name}@${update.toVersion}`;
}

/** Inverse of {@link formatTarget} (scoped npm names keep their leading `@`). */
export function parseTarget(target: string): { manifestPath: string; name: string; version: string } | null {
  const hash = target.indexOf("#");
  if (hash <= 0) return null;
  const rest = target.slice(hash + 1);
  const at = rest.lastIndexOf("@");
  if (at <= 0) return null;
  return { manifestPath: target.slice(0, hash), name: rest.slice(0, at), version: rest.slice(at + 1) };
}

/** Sorted, unique targets of a group. */
export function buildTargets(updates: readonly PrUpdate[]): string[] {
  return [...new Set(updates.map(formatTarget))].sort();
}

/**
 * `"<prefix> update react to 19.3.0"` for one dependency name (one version), `"<prefix> update react"` for one
 * name at several versions, else `"<prefix> update 7 dependencies"`. Also the PR title.
 */
export function buildCommitMessage(commitPrefix: string, updates: readonly PrUpdate[]): string {
  const names = [...new Set(updates.map((update) => update.name))];
  let subject: string;
  if (names.length === 1) {
    const versions = [...new Set(updates.map((update) => update.toVersion))];
    subject = versions.length === 1 ? `update ${names[0]} to ${versions[0]}` : `update ${names[0]}`;
  } else subject = `update ${names.length} dependencies`;
  const prefix = commitPrefix.trim();
  return prefix ? `${prefix} ${subject}` : subject.charAt(0).toUpperCase() + subject.slice(1);
}

/** PR title = commit subject. */
export const buildPrTitle = buildCommitMessage;

/**
 * Inline code span that is safe for any content (GitHub never links mentions inside code), so dependency names
 * like `@types/node` stay verbatim in the PR body without becoming mentions. The fence is one backtick longer than
 * the longest backtick run in the value, and a value that starts or ends with a backtick is padded with one space on
 * both sides (CommonMark strips exactly that pair).
 */
export function markdownCodeSpan(value: string): string {
  const clean = value.replace(/[\r\n|]/g, " ");
  const longestRun = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const pad = clean.startsWith("`") || clean.endsWith("`") ? " " : "";
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/** Escapes free text for a Markdown table cell / paragraph and defuses `@mentions` and `#refs`. */
export function escapeMarkdownText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_[\]<>|])/g, "\\$1")
    .replace(/#(\d)/g, "#&#8203;$1")
    .replace(/@/g, "@&#8203;");
}

function registryUrl(update: PrUpdate): string {
  return update.ecosystem === "NPM"
    ? `https://www.npmjs.com/package/${update.name}/v/${encodeURIComponent(update.toVersion)}`
    : `https://pypi.org/project/${encodeURIComponent(update.name)}/${encodeURIComponent(update.toVersion)}/`;
}

function changelogCell(update: PrUpdate): string {
  const links: string[] = [];
  if (update.sourceRepoUrl && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(update.sourceRepoUrl)) {
    links.push(`[releases](${update.sourceRepoUrl}/releases)`);
  }
  links.push(`[${update.ecosystem === "NPM" ? "npm" : "PyPI"}](${registryUrl(update)})`);
  return links.join(" · ");
}

function dateCell(date: Date | null): string {
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "—";
}

export interface SkippedUpdate {
  name: string;
  manifestPath: string;
  /** Short, user-safe reason ("2.0.0 is younger than 3 days"). */
  reason: string;
}

export interface PrBodyInput {
  groupKey: string;
  updates: readonly PrUpdate[];
  /** Updates of this group left out of the PR (shown as notes). */
  skipped?: readonly SkippedUpdate[];
  /** Project page in RepoPulse (settings link in the footer). */
  projectUrl: string;
}

/**
 * Markdown body: a table (dependency, manifest, from → to, level, released, changelog), notes for skipped
 * updates, the footer "Opened by RepoPulse · settings: <project URL>" and the hidden marker. Never longer than
 * {@link PR_BODY_MAX_LENGTH}: extra rows are summarized.
 */
export function buildPrBody(input: PrBodyInput): string {
  const header = [
    `This pull request updates ${input.updates.length === 1 ? "1 dependency" : `${input.updates.length} dependencies`}.`,
    "",
    "| Dependency | Manifest | Version | Level | Released | Changelog |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  const sorted = [...input.updates].sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.manifestPath < b.manifestPath ? -1 : a.manifestPath > b.manifestPath ? 1 : 0),
  );
  const rows = sorted.map(
    (update) =>
      `| ${markdownCodeSpan(update.name)} | ${markdownCodeSpan(update.manifestPath)} | ${update.fromVersion ? markdownCodeSpan(update.fromVersion) : "—"} → ${markdownCodeSpan(update.toVersion)} | ${update.level ? update.level.toLowerCase() : "—"} | ${dateCell(update.releasedAt)} | ${changelogCell(update)} |`,
  );
  const notes: string[] = [];
  if (input.skipped && input.skipped.length > 0) {
    notes.push("", "**Not included:**", "");
    for (const skipped of input.skipped) {
      notes.push(`- ${markdownCodeSpan(skipped.name)} in ${markdownCodeSpan(skipped.manifestPath)}: ${escapeMarkdownText(skipped.reason)}`);
    }
  }
  const footer = [
    "",
    "---",
    `Opened by RepoPulse · settings: ${input.projectUrl}`,
    "",
    depsPrMarker(input.groupKey),
  ];
  const budget = PR_BODY_MAX_LENGTH - [...header, ...footer].join("\n").length - 200;
  const kept: string[] = [];
  let used = 0;
  for (const row of rows) {
    if (used + row.length + 1 > budget) break;
    kept.push(row);
    used += row.length + 1;
  }
  if (kept.length < rows.length) kept.push(`| …and ${rows.length - kept.length} more | | | | | |`);
  let noteLines = notes;
  const remaining = budget - used;
  if (notes.join("\n").length > remaining) {
    noteLines = ["", `**Not included:** ${input.skipped?.length ?? 0} updates (see the project page).`];
  }
  return [...header, ...kept, ...noteLines, ...footer].join("\n");
}
