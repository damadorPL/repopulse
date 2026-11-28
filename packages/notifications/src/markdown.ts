import type { NotificationReleaseInput, SemverType } from "./types.js";

/**
 * Text helpers shared by the formatters. Release notes are GitHub-flavored Markdown that often
 * contains raw HTML (`<details>`, `<img>`, comments), which chat services and push apps can't render.
 */

const SEMVER_LABELS: Record<SemverType, string> = {
  MAJOR: "Major",
  MINOR: "Minor",
  PATCH: "Patch",
  PRERELEASE: "Pre-release",
  OTHER: "Release",
};

function semverLabel(type: SemverType): string {
  return SEMVER_LABELS[type];
}

/** "Major release", "Pre-release", "Git tag", "Commit", … */
export function releaseKindLabel(release: Pick<NotificationReleaseInput, "semverType" | "source">): string {
  if (release.source === "COMMIT") return "Commit";
  if (release.source === "TAG")
    return release.semverType === "OTHER" ? "Git tag" : `${semverLabel(release.semverType)} tag`;
  return release.semverType === "PRERELEASE" ? "Pre-release" : `${semverLabel(release.semverType)} release`;
}

/** Label of the "open on GitHub" button: tags and commits have no release notes page. */
export function githubLinkLabel(release: Pick<NotificationReleaseInput, "source">): string {
  if (release.source === "COMMIT") return "View commit on GitHub";
  return release.source === "TAG" ? "View on GitHub" : "Release notes on GitHub";
}

/** Trims all trailing occurrences of `char` (single character) without regex backtracking. */
export function trimTrailingChar(value: string, char: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === char) end--;
  return end === value.length ? value : value.slice(0, end);
}

const BLOCK_HTML_TAGS = new Set([
  "p",
  "div",
  "details",
  "summary",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
]);

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isTagNameChar(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 45;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13;
}

function stripHtmlOnce(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, lt);

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end !== -1) {
        i = end + 3;
        continue;
      }
    }

    let pos = lt + 1;
    const isClosing = text.charCodeAt(pos) === 47;
    if (isClosing) pos++;
    if (pos < text.length && isAsciiLetter(text.charCodeAt(pos))) {
      const nameStart = pos;
      pos++;
      while (pos < text.length && isTagNameChar(text.charCodeAt(pos))) pos++;
      const tagName = text.slice(nameStart, pos).toLowerCase();
      const afterName = pos < text.length ? text.charCodeAt(pos) : -1;
      if (text.charCodeAt(pos - 1) !== 45 && afterName !== 95) {
        if (tagName === "br" && !isClosing) {
          let brPos = pos;
          while (brPos < text.length && isAsciiWhitespace(text.charCodeAt(brPos))) brPos++;
          if (text.charCodeAt(brPos) === 47) brPos++;
          if (text.charCodeAt(brPos) === 62) {
            out += "\n";
            i = brPos + 1;
            continue;
          }
        }
        const close = text.indexOf(">", pos);
        if (close !== -1) {
          if (BLOCK_HTML_TAGS.has(tagName)) out += "\n";
          i = close + 1;
          continue;
        }
      }
    }

    out += "<";
    i = lt + 1;
  }
  return out;
}

/** Normalizes line endings, drops HTML comments and tags (keeping their text) and squeezes blank lines. */
export function cleanMarkdown(markdown: string): string {
  let text = markdown.replace(/\r\n?/g, "\n");
  let prev: string;
  do {
    prev = text;
    text = stripHtmlOnce(text);
  } while (text !== prev);

  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cuts at a code-point boundary, preferring the last line break or space near the end. */
export function truncateText(text: string, maxLength: number, ellipsis = "…"): string {
  if (text.length <= maxLength) return text;
  const budget = Math.max(0, maxLength - ellipsis.length);
  let cut = budget;
  // Never split a surrogate pair.
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  const window = text.slice(0, cut);
  const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
  if (boundary > budget * 0.8) cut = boundary;
  return `${text.slice(0, cut).trimEnd()}${ellipsis}`;
}

/** Like `truncateText`, but the limit is UTF-8 bytes (ntfy's message limit is 4096 bytes). */
export function truncateBytes(text: string, maxBytes: number, ellipsis = "…"): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= budget) low = mid;
    else high = mid - 1;
  }
  return truncateText(text, low + ellipsis.length, ellipsis);
}

/** Release notes cleaned for display, or a placeholder when there are none. */
export function releaseSummary(release: NotificationReleaseInput): string {
  const cleaned = cleanMarkdown(release.bodyMarkdown);
  return cleaned || "_No release notes were published for this version._";
}

function escapeSlackEntities(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * GitHub Markdown → Slack mrkdwn: `*bold*`, `<url|text>` links, `•` bullets, headings as bold
 * lines. `&`, `<` and `>` are escaped first, as Slack requires.
 */
export function markdownToSlack(markdown: string): string {
  const fences: string[] = [];
  const inlineCodes: string[] = [];
  /* oxlint-disable no-control-regex -- null/SOH delimiters protect fenced and inline code during conversion. */
  const sanitized = markdown.replace(/\u0000|\u0001/g, "");

  const withoutFences = sanitized.replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code: string) => {
    fences.push(code.replace(/\n$/, ""));
    return `\u0000${fences.length - 1}\u0000`;
  });

  const withoutCode = withoutFences.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCodes.push(code);
    return `\u0001${inlineCodes.length - 1}\u0001`;
  });

  const formatSlackLinkText = (text: string) =>
    text
      .replace(/\u0001(\d+)\u0001/g, (_m, idx: string) => `\`${escapeSlackEntities(inlineCodes[Number(idx)] ?? "")}\``)
      .replace(/\|/g, "&#124;");

  const converted = escapeSlackEntities(withoutCode)
    .replace(/^&gt; ?/gm, "> ")
    .replace(
      /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
      (_m, alt: string, url: string) => `<${url}|${formatSlackLinkText(alt) || "image"}>`,
    )
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_m, text: string, url: string) => `<${url}|${formatSlackLinkText(text)}>`,
    )
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, (_m, heading: string) => `*${heading.replace(/\*\*/g, "")}*`)
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a?: string, b?: string) => `*${a ?? b}*`)
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ");

  return converted
    .replace(
      /\u0001(\d+)\u0001/g,
      (_m, index: string) => `\`${escapeSlackEntities(inlineCodes[Number(index)] ?? "")}\``,
    )
    .replace(
      /\u0000(\d+)\u0000/g,
      (_m, index: string) => `\`\`\`${escapeSlackEntities(fences[Number(index)] ?? "")}\`\`\``,
    );
  /* oxlint-enable no-control-regex */
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Returns `href.trim()` when it is a valid `http:` or `https:` URL, else `null`. */
export function safeHttpUrl(href: string): string | null {
  const trimmed = href.trim();
  if (!/^https?:/i.test(trimmed)) return null;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** Validates `#rrggbb` hex colors for inline HTML styles, falling back to a neutral slate color. */
export function safeHexColor(colorHex: string, fallback = "#475569"): string {
  return /^#[0-9a-f]{6}$/i.test(colorHex) ? colorHex : fallback;
}

/** Inline Markdown on already-escaped text: code, bold, italics, http(s) links. */
function inlineHtml(escaped: string): string {
  const codeSpans: string[] = [];
  /* oxlint-disable no-control-regex -- null delimiters protect inline code spans during formatting. */
  const withPlaceholders = escaped.replace(/\u0000/g, "").replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(
      `<code style="font-family:SFMono-Regular,Consolas,monospace;background:#f1f5f9;border-radius:4px;padding:1px 4px;font-size:13px">${code}</code>`,
    );
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  /* oxlint-enable no-control-regex */

  const formatted = withPlaceholders
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(
      /!?\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g,
      (_m, text: string, url: string) => `<a href="${url}" style="color:#2563eb">${text}</a>`,
    );

  // oxlint-disable-next-line no-control-regex -- null delimiters protect inline code spans during formatting.
  return formatted.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codeSpans[Number(index)] ?? "");
}

/**
 * A deliberately small Markdown → HTML renderer for emails: everything is escaped first, so
 * release notes can never inject markup. Supports headings, lists, code blocks, quotes,
 * paragraphs and inline code/bold/italics/links.
 */
export function markdownToEmailHtml(markdown: string): string {
  const lines = markdown.split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length)
      html.push(`<p style="margin:0 0 12px">${paragraph.map((l) => inlineHtml(escapeHtml(l))).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list)
      html.push(
        `<ul style="margin:0 0 12px;padding-left:20px">${list.map((item) => `<li style="margin:0 0 4px">${item}</li>`).join("")}</ul>`,
      );
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (line.startsWith("```")) {
        html.push(
          `<pre style="margin:0 0 12px;padding:12px;background:#f1f5f9;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.45"><code>${escapeHtml(code.join("\n"))}</code></pre>`,
        );
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      flushParagraph();
      flushList();
      const size = heading[1].length <= 2 ? 17 : 15;
      html.push(
        `<p style="margin:16px 0 8px;font-size:${size}px;font-weight:600">${inlineHtml(escapeHtml(heading[2]))}</p>`,
      );
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      list ??= [];
      list.push(inlineHtml(escapeHtml(item[1] ?? "")));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      html.push(
        `<blockquote style="margin:0 0 12px;padding:0 12px;border-left:3px solid #cbd5e1;color:#475569">${inlineHtml(escapeHtml(quote[1] ?? ""))}</blockquote>`,
      );
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (code) html.push(`<pre style="margin:0 0 12px"><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join("\n");
}
