import { escapeHtml, truncateBytes, truncateText } from "../markdown.js";
import type { NotificationChannel, SemverType } from "../types.js";
import { DISCORD_COLORS } from "./discord.js";
import { encodeHeaderValue, resolveGotifyEndpoint, type PreparedRequest } from "./ntfy-gotify.js";

/**
 * Dependency notifications (Slice 08, §3.11): a digest of outdated dependencies after a scan, and
 * update pull request events. Structural inputs only: this package must not depend on
 * `@repopulse/db` or `@repopulse/deps`.
 */

/**
 * Most updates listed in one message; the rest become "and N more". Mirrors `DIGEST_MAX_ITEMS` of
 * `@repopulse/deps` (§3.11.3), defined here because notifications must not depend on that package.
 */
export const DIGEST_MAX_ITEMS = 25;

export type DependencyUpdateLevel = SemverType;

export interface DependencyUpdateInput {
  name: string;
  /** Current (locked or declared) version; `null` when unknown. */
  from: string | null;
  to: string;
  level: DependencyUpdateLevel | null;
  /** Manifest path, e.g. `package.json` or `apps/api/requirements.txt`. */
  manifest: string;
  ecosystem?: "NPM" | "PYPI";
}

/**
 * - `opened`: the bot opened the PR. `updated`: it pushed new versions to it.
 * - `edited`: someone else pushed to the PR branch, so the bot stopped updating it.
 * - `access_lost`: the owner lost write access (or the App installation), the project fell back to notify-only.
 */
export type DependencyPullRequestEvent = "opened" | "updated" | "edited" | "access_lost";

export interface DependencyPullRequestInput {
  event: DependencyPullRequestEvent;
  /** May be missing for `access_lost` (no PR involved). */
  number?: number | null;
  url?: string | null;
  title?: string | null;
}

export interface DependencyNotificationInput {
  /** `url` is the project page in RepoPulse (every link points there); `htmlUrl` the GitHub repository. */
  project: { fullName: string; url: string; htmlUrl?: string | null };
  kind: "digest" | "pull_request";
  updates: DependencyUpdateInput[];
  /** Total outdated count when `updates` was already cut by the caller (default `updates.length`). */
  totalUpdates?: number;
  pullRequest?: DependencyPullRequestInput | null;
  rule: { id?: string; channel: NotificationChannel; destinationUrl: string | null };
  /** Needed for email rules without a recipient (the account email). */
  user?: { email: string; name?: string | null } | null;
  /** "Send Test" delivery: custom webhooks get `"test": true` and `X-RepoPulse-Event: test`. */
  test?: boolean;
}

/** Everything the formatters need, computed once by the dispatcher (see {@link buildDependencyContext}). */
export interface DependencyMessageContext extends DependencyNotificationInput {
  appBaseUrl: string;
  /** At most {@link DIGEST_MAX_ITEMS}, highest level first. */
  shown: DependencyUpdateInput[];
  total: number;
  /** `total - shown.length`. */
  more: number;
  /** Highest level among all updates (`OTHER` when none). */
  highest: DependencyUpdateLevel;
  hasMajor: boolean;
  event: "dependencies.outdated" | "dependencies.pull_request";
}

const LEVEL_RANK: Record<DependencyUpdateLevel, number> = { MAJOR: 4, MINOR: 3, PATCH: 2, PRERELEASE: 1, OTHER: 0 };

const LEVEL_LABELS: Record<DependencyUpdateLevel, string> = {
  MAJOR: "Major",
  MINOR: "Minor",
  PATCH: "Patch",
  PRERELEASE: "Pre-release",
  OTHER: "Other",
};

export function dependencyLevelLabel(level: DependencyUpdateLevel | null): string {
  return LEVEL_LABELS[level ?? "OTHER"];
}

export function buildDependencyContext(input: DependencyNotificationInput, appBaseUrl: string): DependencyMessageContext {
  const sorted = [...input.updates].sort((a, b) => LEVEL_RANK[b.level ?? "OTHER"] - LEVEL_RANK[a.level ?? "OTHER"]);
  const shown = sorted.slice(0, DIGEST_MAX_ITEMS);
  const total = Math.max(input.totalUpdates ?? 0, input.updates.length);
  const highest = sorted[0]?.level ?? "OTHER";
  return {
    ...input,
    appBaseUrl,
    shown,
    total,
    more: total - shown.length,
    highest,
    hasMajor: input.updates.some((u) => u.level === "MAJOR"),
    event: input.kind === "digest" ? "dependencies.outdated" : "dependencies.pull_request",
  };
}

// ─── Shared text ───────────────────────────────────────────────────────────

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function prLabel(ctx: DependencyMessageContext): string {
  const number = ctx.pullRequest?.number;
  return number ? `pull request #${number}` : "pull request";
}

/** One line, no Markdown: used for titles, subjects and fallbacks. */
export function dependencyHeadline(ctx: DependencyMessageContext): string {
  const name = ctx.project.fullName;
  if (ctx.kind === "digest") return `${name}: ${plural(ctx.total, "outdated dependency", "outdated dependencies")}`;
  switch (ctx.pullRequest?.event) {
    case "updated":
      return `${name}: ${prLabel(ctx)} updated`;
    case "edited":
      return `${name}: ${prLabel(ctx)} was changed by someone else`;
    case "access_lost":
      return `${name}: dependency pull requests paused`;
    case "opened":
    default:
      return `${name}: ${prLabel(ctx)} opened`;
  }
}

/** One sentence explaining the event, or `null` when the update list says it all. */
export function dependencyIntro(ctx: DependencyMessageContext): string | null {
  if (ctx.kind === "digest") return null;
  const title = ctx.pullRequest?.title?.trim();
  switch (ctx.pullRequest?.event) {
    case "edited":
      return "Someone else pushed to the branch of this pull request, so RepoPulse no longer updates it.";
    case "access_lost":
      return "RepoPulse can no longer open pull requests for this repository with your account (write access or the GitHub App installation is missing). The project switched to notify-only.";
    case "updated":
      return title ? `New versions were pushed: ${title}` : "New versions were pushed to the pull request.";
    case "opened":
    default:
      return title ?? null;
  }
}

function plainName(name: string): string {
  return name.replace(/[`\r\n]/g, "");
}

function versionChange(update: DependencyUpdateInput): string {
  return update.from ? `${update.from} → ${update.to}` : `→ ${update.to}`;
}

/** `- \`react\` 18.3.1 → 19.3.0 · Major · package.json` (names in code spans: `_` and `*` stay literal). */
function markdownLine(update: DependencyUpdateInput): string {
  return `- \`${plainName(update.name)}\` ${versionChange(update)} · ${dependencyLevelLabel(update.level)} · ${update.manifest}`;
}

function moreLine(ctx: DependencyMessageContext): string | null {
  return ctx.more > 0 ? `… and ${ctx.more} more` : null;
}

/** The Markdown body shared by Discord, ntfy and Gotify. */
export function dependencyMarkdown(ctx: DependencyMessageContext): string {
  const parts: string[] = [];
  if (ctx.test) parts.push("_This is a test notification from RepoPulse._");
  const intro = dependencyIntro(ctx);
  if (intro) parts.push(intro);
  if (ctx.shown.length) parts.push([...ctx.shown.map(markdownLine), moreLine(ctx)].filter(Boolean).join("\n"));
  return parts.join("\n\n");
}

function pullRequestUrl(ctx: DependencyMessageContext): string | null {
  return ctx.pullRequest?.url ?? null;
}

// ─── Discord ───────────────────────────────────────────────────────────────

export interface DependencyDiscordPayload {
  username: string;
  allowed_mentions: { parse: string[] };
  embeds: Array<{
    title: string;
    url: string;
    color: number;
    description: string;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer: { text: string };
    timestamp: string;
  }>;
}

/** Embed colored by the highest update level; edited / access-lost PR events are amber. */
export function formatDependencyDiscordPayload(ctx: DependencyMessageContext, now = new Date()): DependencyDiscordPayload {
  const links = [`[Open in RepoPulse](${ctx.project.url})`];
  const prUrl = pullRequestUrl(ctx);
  if (prUrl) links.push(`[View ${prLabel(ctx)}](${prUrl})`);
  const footer = `\n\n${links.join(" · ")}`;
  const description = `${truncateText(dependencyMarkdown(ctx) || " ", 4096 - footer.length - 10)}${footer}`;
  const warning = ctx.pullRequest?.event === "edited" || ctx.pullRequest?.event === "access_lost";

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  if (ctx.total > 0) fields.push({ name: "Updates", value: String(ctx.total), inline: true });
  if (ctx.total > 0) fields.push({ name: "Highest", value: dependencyLevelLabel(ctx.highest), inline: true });

  return {
    username: "RepoPulse",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: truncateText(dependencyHeadline(ctx), 256),
        url: ctx.project.url,
        color: warning ? DISCORD_COLORS.PRERELEASE : DISCORD_COLORS[ctx.highest],
        description,
        fields,
        footer: { text: ctx.test ? "RepoPulse · Dependencies · test notification" : "RepoPulse · Dependencies" },
        timestamp: now.toISOString(),
      },
    ],
  };
}

// ─── Slack ─────────────────────────────────────────────────────────────────

type SlackText = { type: "plain_text"; text: string; emoji?: boolean } | { type: "mrkdwn"; text: string };

export interface DependencySlackPayload {
  text: string;
  blocks: Array<
    | { type: "header"; text: SlackText }
    | { type: "context"; elements: SlackText[] }
    | { type: "section"; text: SlackText }
    | { type: "actions"; elements: Array<{ type: "button"; text: SlackText; url: string; style?: "primary"; action_id: string }> }
  >;
  unfurl_links: boolean;
  unfurl_media: boolean;
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatDependencySlackPayload(ctx: DependencyMessageContext): DependencySlackPayload {
  const headline = dependencyHeadline(ctx);
  const context = [
    ctx.kind === "digest" ? "*Dependencies*" : "*Dependency pull request*",
    ctx.total > 0 ? plural(ctx.total, "update", "updates") : null,
    ctx.total > 0 ? `highest: ${dependencyLevelLabel(ctx.highest)}` : null,
    ctx.test ? "_Test notification_" : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  const blocks: DependencySlackPayload["blocks"] = [
    { type: "header", text: { type: "plain_text", text: truncateText(headline, 150), emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: context }] },
  ];
  const intro = dependencyIntro(ctx);
  if (intro) blocks.push({ type: "section", text: { type: "mrkdwn", text: truncateText(escapeSlack(intro), 2900) } });
  if (ctx.shown.length) {
    const lines = ctx.shown.map(
      (u) => `• \`${escapeSlack(plainName(u.name))}\` ${escapeSlack(versionChange(u))} · ${dependencyLevelLabel(u.level)} · ${escapeSlack(u.manifest)}`,
    );
    const more = moreLine(ctx);
    if (more) lines.push(`_${more}_`);
    // Built as mrkdwn directly (escaped), not converted from the shared Markdown.
    blocks.push({ type: "section", text: { type: "mrkdwn", text: truncateText(lines.join("\n"), 2900) } });
  }
  const buttons: Array<{ type: "button"; text: SlackText; url: string; style?: "primary"; action_id: string }> = [
    { type: "button", text: { type: "plain_text", text: "Open in RepoPulse" }, url: ctx.project.url, style: "primary", action_id: "open_repopulse" },
  ];
  const prUrl = pullRequestUrl(ctx);
  if (prUrl) buttons.push({ type: "button", text: { type: "plain_text", text: "View pull request" }, url: prUrl, action_id: "open_pull_request" });
  blocks.push({ type: "actions", elements: buttons });

  return { text: headline, blocks, unfurl_links: false, unfurl_media: false };
}

// ─── ntfy / Gotify ─────────────────────────────────────────────────────────

const NTFY_BODY_LIMIT_BYTES = 3800;
const GOTIFY_MESSAGE_LIMIT = 3800;

/** ntfy: Markdown body; priority `high` when a major update is present; the click opens the project page. */
export function buildDependencyNtfyRequest(ctx: DependencyMessageContext, destinationUrl: string): PreparedRequest {
  const actions = [`view, Open in RepoPulse, ${ctx.project.url}`];
  const prUrl = pullRequestUrl(ctx);
  if (prUrl) actions.push(`view, View pull request, ${prUrl}`);
  const warning = ctx.pullRequest?.event === "edited" || ctx.pullRequest?.event === "access_lost";
  return {
    url: new URL(destinationUrl),
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Title: encodeHeaderValue(truncateText(dependencyHeadline(ctx), 250)),
      Priority: ctx.hasMajor ? "high" : "default",
      Tags: warning ? "package,warning" : "package",
      Click: ctx.project.url,
      Markdown: "yes",
      Actions: actions.join("; "),
    },
    body: truncateBytes(dependencyMarkdown(ctx) || dependencyHeadline(ctx), NTFY_BODY_LIMIT_BYTES),
  };
}

export interface DependencyGotifyMessage {
  title: string;
  message: string;
  priority: number;
  extras: {
    "client::display": { contentType: "text/markdown" };
    "client::notification": { click: { url: string } };
  };
}

/** Gotify: priority 8 when a major update is present, else 5. */
export function formatDependencyGotifyMessage(ctx: DependencyMessageContext): DependencyGotifyMessage {
  const prUrl = pullRequestUrl(ctx);
  const links = [`[Open in RepoPulse](${ctx.project.url})`, ...(prUrl ? [`[View pull request](${prUrl})`] : [])].join(" · ");
  const body = dependencyMarkdown(ctx);
  return {
    title: truncateText(dependencyHeadline(ctx), 250),
    message: `${body ? `${truncateText(body, GOTIFY_MESSAGE_LIMIT)}\n\n` : ""}${links}`,
    priority: ctx.hasMajor ? 8 : 5,
    extras: {
      "client::display": { contentType: "text/markdown" },
      "client::notification": { click: { url: ctx.project.url } },
    },
  };
}

export function buildDependencyGotifyRequest(ctx: DependencyMessageContext, destinationUrl: string): PreparedRequest {
  const { url, token } = resolveGotifyEndpoint(destinationUrl);
  return {
    url,
    headers: { "Content-Type": "application/json", "X-Gotify-Key": token },
    body: JSON.stringify(formatDependencyGotifyMessage(ctx)),
  };
}

// ─── Custom webhook ────────────────────────────────────────────────────────

export interface DependencyWebhookPayload {
  event: "dependencies.outdated" | "dependencies.pull_request";
  test: boolean;
  repository: { fullName: string; htmlUrl: string | null };
  /** At most {@link DIGEST_MAX_ITEMS}; `totalUpdates` counts all of them. */
  updates: Array<{
    name: string;
    from: string | null;
    to: string;
    level: DependencyUpdateLevel | null;
    manifest: string;
    ecosystem: "NPM" | "PYPI" | null;
  }>;
  totalUpdates: number;
  pullRequest: { event: DependencyPullRequestEvent; number: number | null; url: string | null; title: string | null } | null;
  rule: { id: string | null };
  links: { repopulse: string; pullRequest: string | null };
}

export function formatDependencyWebhookPayload(ctx: DependencyMessageContext): DependencyWebhookPayload {
  const pr = ctx.pullRequest;
  return {
    event: ctx.event,
    test: ctx.test === true,
    repository: { fullName: ctx.project.fullName, htmlUrl: ctx.project.htmlUrl ?? null },
    updates: ctx.shown.map((u) => ({
      name: u.name,
      from: u.from,
      to: u.to,
      level: u.level,
      manifest: u.manifest,
      ecosystem: u.ecosystem ?? null,
    })),
    totalUpdates: ctx.total,
    pullRequest: pr ? { event: pr.event, number: pr.number ?? null, url: pr.url ?? null, title: pr.title ?? null } : null,
    rule: { id: ctx.rule.id ?? null },
    links: { repopulse: ctx.project.url, pullRequest: pr?.url ?? null },
  };
}

// ─── Email ─────────────────────────────────────────────────────────────────

const BADGE_COLORS: Record<DependencyUpdateLevel, { bg: string; fg: string }> = {
  MAJOR: { bg: "#fee2e2", fg: "#b91c1c" },
  MINOR: { bg: "#dbeafe", fg: "#1d4ed8" },
  PATCH: { bg: "#d1fae5", fg: "#047857" },
  PRERELEASE: { bg: "#fef3c7", fg: "#b45309" },
  OTHER: { bg: "#f1f5f9", fg: "#475569" },
};

function emailButton(href: string, label: string, primary: boolean): string {
  const style = primary
    ? "background:#0f172a;color:#ffffff;border:1px solid #0f172a"
    : "background:#ffffff;color:#0f172a;border:1px solid #cbd5e1";
  return `<a href="${escapeHtml(href)}" style="display:inline-block;${style};border-radius:6px;padding:10px 16px;font-size:14px;font-weight:600;text-decoration:none;margin:0 8px 8px 0">${escapeHtml(label)}</a>`;
}

export interface RenderedDependencyEmail {
  subject: string;
  text: string;
  html: string;
}

/** HTML table of the updates (inline styles only) plus a plain-text part. */
export function renderDependencyEmail(ctx: DependencyMessageContext): RenderedDependencyEmail {
  const headline = dependencyHeadline(ctx);
  const subject = `${ctx.test ? "[Test] " : ""}${headline}${ctx.kind === "digest" && ctx.hasMajor ? " (major)" : ""}`;
  const intro = dependencyIntro(ctx);
  const prUrl = pullRequestUrl(ctx);
  const settingsUrl = `${ctx.appBaseUrl}/settings/notifications`;

  const text = [
    ctx.test ? "This is a test notification from RepoPulse.\n" : null,
    headline,
    intro ? `\n${intro}` : null,
    ctx.shown.length ? "" : null,
    ...ctx.shown.map((u) => `- ${u.name} ${versionChange(u)} (${dependencyLevelLabel(u.level)}) in ${u.manifest}`),
    moreLine(ctx),
    "",
    `Open in RepoPulse: ${ctx.project.url}`,
    prUrl ? `Pull request: ${prUrl}` : null,
    "",
    `—\nSent by a RepoPulse notification rule. Manage rules: ${settingsUrl}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const cell = "padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;vertical-align:top";
  const rows = ctx.shown
    .map((u) => {
      const badge = BADGE_COLORS[u.level ?? "OTHER"];
      return `<tr><td style="${cell};font-family:SFMono-Regular,Consolas,monospace;word-break:break-all">${escapeHtml(u.name)}</td><td style="${cell};color:#64748b;word-break:break-all">${escapeHtml(u.manifest)}</td><td style="${cell};white-space:nowrap">${escapeHtml(u.from ?? "—")} → <strong>${escapeHtml(u.to)}</strong></td><td style="${cell}"><span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${badge.bg};color:${badge.fg};font-size:12px;font-weight:600">${escapeHtml(dependencyLevelLabel(u.level))}</span></td></tr>`;
    })
    .join("\n");
  const head = "padding:8px 10px;border-bottom:2px solid #e2e8f0;font-size:12px;text-align:left;color:#64748b;font-weight:600";
  const table = ctx.shown.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 12px">
<tr><th style="${head}">Dependency</th><th style="${head}">Manifest</th><th style="${head}">Version</th><th style="${head}">Level</th></tr>
${rows}
</table>${ctx.more > 0 ? `\n<p style="margin:0 0 12px;font-size:13px;color:#64748b">… and ${ctx.more} more</p>` : ""}`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:10px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #e2e8f0;font-size:14px;font-weight:700;letter-spacing:-0.01em">RepoPulse · Dependencies${ctx.test ? ' <span style="font-weight:500;color:#64748b">· test notification</span>' : ""}</td></tr>
<tr><td style="padding:24px 24px 8px">
<p style="margin:0 0 6px;font-size:13px;color:#64748b">${escapeHtml(ctx.project.fullName)}</p>
<p style="margin:0 0 10px;font-size:20px;line-height:1.3;font-weight:700;word-break:break-word">${escapeHtml(headline)}</p>
${intro ? `<p style="margin:0;font-size:14px;line-height:1.6">${escapeHtml(intro)}</p>` : ""}
</td></tr>
<tr><td style="padding:16px 24px 8px">
${table}
</td></tr>
<tr><td style="padding:8px 24px 20px">
${emailButton(ctx.project.url, "Open in RepoPulse", true)}${prUrl ? emailButton(prUrl, "View pull request", false) : ""}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#64748b">
Sent by a RepoPulse notification rule. <a href="${escapeHtml(settingsUrl)}" style="color:#64748b">Manage notification rules</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}
