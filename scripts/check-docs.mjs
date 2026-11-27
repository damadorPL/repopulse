#!/usr/bin/env node
// Validates documentation links, heading anchors, AGENTS.md hygiene/budgets, and workspace coverage.
//   pnpm docs:check
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const ROOT_AGENTS_MAX_LINES = 120;
const SUBPACKAGE_AGENTS_MAX_LINES = 60;
const DISALLOWED_AGENTS_HEADING_RE =
  /\b(project history|history summary|changelog|recent changes|completed (?:delivery|deliveries|initiatives|features|milestones))\b/i;
const BACKTICK_COMMIT_HASH_RE = /`([0-9a-f]{7,40})`/g;
const SLICE_LABEL_RE = /\bslice\s+0?\d+\b/i;
const VERSION_DOCUMENTED_RE = /\bversion\s+documented\b/i;
const SEMVER_LITERAL_RE = /\bv?\d+\.\d+\.\d+(?:\.\d+)?\b/;

/**
 * Recursively collects markdown files matching `predicate` under `dir`.
 * @param {string} dir
 * @param {(relPath: string) => boolean} predicate
 * @returns {string[]}
 */
function walkMarkdown(dir, predicate) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist" || entry.name === ".turbo") {
      continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      results.push(...walkMarkdown(full, predicate));
    } else if (entry.isFile() && predicate(rel)) {
      results.push(rel);
    }
  }
  return results;
}

/**
 * Discovers all active markdown files whose relative links and anchors must remain valid.
 * @returns {string[]}
 */
function discoverActiveMarkdownFiles() {
  const candidates = [
    "README.md",
    "AGENTS.md",
    ...walkMarkdown(path.join(ROOT, "apps"), (rel) => /^apps\/[^/]+\/AGENTS\.md$/.test(rel)),
    ...walkMarkdown(path.join(ROOT, "packages"), (rel) => /^packages\/[^/]+\/AGENTS\.md$/.test(rel)),
    ...walkMarkdown(path.join(ROOT, "docs"), (rel) => rel.endsWith(".md")),
  ];
  return [...new Set(candidates)].filter((rel) => existsSync(path.join(ROOT, rel))).toSorted();
}

/**
 * Removes inline `<...>` HTML tag spans iteratively without regex sanitization.
 * @param {string} input
 * @returns {string}
 */
function stripInlineHtmlTags(input) {
  let text = input;
  for (;;) {
    const start = text.indexOf("<");
    if (start === -1) break;
    const end = text.indexOf(">", start + 1);
    if (end === -1) break;
    text = text.slice(0, start) + text.slice(end + 1);
  }
  return text;
}

/**
 * Converts a markdown heading into its GitHub-compatible anchor slug.
 * @param {string} rawHeading
 * @returns {string}
 */
function slugifyHeading(rawHeading) {
  const withoutLinks = rawHeading.replace(/\s+#+\s*$/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const plain = stripInlineHtmlTags(withoutLinks).replace(/[`*~]/g, "").trim().toLowerCase();

  return plain.replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-");
}

/**
 * Extracts GitHub heading anchor slugs for a markdown file (cached by absolute path).
 * @param {string} absFile
 * @param {Map<string, Set<string>>} cache
 * @returns {Set<string>}
 */
function getHeadingSlugs(absFile, cache) {
  const cached = cache.get(absFile);
  if (cached) return cached;

  const text = readFileSync(absFile, "utf8");
  const lines = text.split(/\r?\n/);
  /** @type {Set<string>} */
  const slugs = new Set();
  /** @type {Map<string, number>} */
  const counts = new Map();

  let fence = null;
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = marker[0];
      } else if (fence === marker[0]) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (!headingMatch) continue;
    const base = slugifyHeading(headingMatch[1]);
    if (!base) continue;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${seen}`);
  }

  cache.set(absFile, slugs);
  return slugs;
}

/**
 * Strips fenced code blocks and inline code spans while preserving line numbers.
 * @param {string} text
 * @returns {string}
 */
function stripCodeFromMarkdown(text) {
  const lines = text.split(/\r?\n/);
  let fence = null;
  const cleaned = lines.map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = marker[0];
      } else if (fence === marker[0]) {
        fence = null;
      }
      return "";
    }
    if (fence) return "";
    return line.replace(/`[^`\n]*`/g, "");
  });
  return cleaned.join("\n");
}

/**
 * Validates relative links and heading anchors across active markdown docs.
 * @param {string[]} files
 * @returns {{ errors: string[], linkCount: number }}
 */
function checkMarkdownLinks(files) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, Set<string>>} */
  const headingCache = new Map();
  let linkCount = 0;

  const linkRegex = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

  for (const relFile of files) {
    const absFile = path.join(ROOT, relFile);
    const dir = path.dirname(absFile);
    const stripped = stripCodeFromMarkdown(readFileSync(absFile, "utf8"));

    for (const match of stripped.matchAll(linkRegex)) {
      const rawTarget = match[1].trim();
      if (
        !rawTarget ||
        rawTarget.startsWith("http://") ||
        rawTarget.startsWith("https://") ||
        rawTarget.startsWith("mailto:") ||
        rawTarget.startsWith("file://") ||
        rawTarget.startsWith("conversation://")
      ) {
        continue;
      }

      linkCount += 1;
      const hashIndex = rawTarget.indexOf("#");
      const rawPath = (hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex)).split("?")[0]?.trim() ?? "";
      const anchor = hashIndex === -1 ? "" : rawTarget.slice(hashIndex + 1).trim();

      const targetAbs = rawPath ? path.resolve(dir, rawPath) : absFile;
      if (!existsSync(targetAbs)) {
        errors.push(`${relFile}: broken relative link -> ${rawTarget}`);
        continue;
      }

      const st = statSync(targetAbs);
      if (!st.isFile() && !st.isDirectory()) {
        errors.push(`${relFile}: invalid link target -> ${rawTarget}`);
        continue;
      }

      if (anchor) {
        if (!st.isFile() || !targetAbs.endsWith(".md")) {
          errors.push(`${relFile}: anchor link targets non-markdown path -> ${rawTarget}`);
          continue;
        }
        const slugs = getHeadingSlugs(targetAbs, headingCache);
        if (!slugs.has(anchor)) {
          errors.push(`${relFile}: broken heading anchor #${anchor} in -> ${rawTarget}`);
        }
      }
    }
  }

  return { errors, linkCount };
}

/**
 * Checks line budgets, timeless hygiene, and Next.js marker integrity across AGENTS.md files.
 * @returns {{ errors: string[], fileCount: number }}
 */
function checkAgentsMdHygiene() {
  /** @type {string[]} */
  const errors = [];
  const candidates = [
    "AGENTS.md",
    ...walkMarkdown(path.join(ROOT, "apps"), (rel) => /^apps\/[^/]+\/AGENTS\.md$/.test(rel)),
    ...walkMarkdown(path.join(ROOT, "packages"), (rel) => /^packages\/[^/]+\/AGENTS\.md$/.test(rel)),
  ];
  const files = [...new Set(candidates)].filter((rel) => existsSync(path.join(ROOT, rel))).toSorted();

  for (const relPath of files) {
    const absPath = path.join(ROOT, relPath);
    const raw = readFileSync(absPath, "utf8");
    const lines = raw.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();

    const maxLines = relPath === "AGENTS.md" ? ROOT_AGENTS_MAX_LINES : SUBPACKAGE_AGENTS_MAX_LINES;
    if (lines.length > maxLines) {
      errors.push(`${relPath}: ${lines.length} lines exceeds max ${maxLines} lines`);
    }

    if (relPath === "apps/web/AGENTS.md") {
      if (!raw.includes("<!-- BEGIN:nextjs-agent-rules -->") || !raw.includes("<!-- END:nextjs-agent-rules -->")) {
        errors.push("apps/web/AGENTS.md: missing Next.js <!-- BEGIN/END:nextjs-agent-rules --> marker block");
      }
    }

    let fence = null;
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!fence) {
          fence = marker[0];
        } else if (fence === marker[0]) {
          fence = null;
        }
        continue;
      }

      const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch && DISALLOWED_AGENTS_HEADING_RE.test(headingMatch[1])) {
        errors.push(`${relPath}:${idx + 1}: disallowed history/changelog heading ("${headingMatch[1].trim()}")`);
      }

      for (const match of line.matchAll(BACKTICK_COMMIT_HASH_RE)) {
        const token = match[1];
        if (/\d/.test(token) && /[a-f]/.test(token)) {
          errors.push(`${relPath}:${idx + 1}: git commit hash \`${token}\` is not allowed in AGENTS.md`);
        }
      }

      if (!fence) {
        if (SLICE_LABEL_RE.test(line)) {
          errors.push(`${relPath}:${idx + 1}: slice label is not allowed in AGENTS.md`);
        }
        if (VERSION_DOCUMENTED_RE.test(line)) {
          errors.push(`${relPath}:${idx + 1}: "Version documented" banner is not allowed in AGENTS.md`);
        }
        if (SEMVER_LITERAL_RE.test(line)) {
          errors.push(`${relPath}:${idx + 1}: 3+ segment semver literal is not allowed in AGENTS.md`);
        }
      }
    }
  }

  return { errors, fileCount: files.length };
}

/**
 * Ensures every code workspace (`apps/*` and `packages/*` containing `src/`) has an AGENTS.md,
 * a matching `docs/` guide, and links in both root `AGENTS.md` and `docs/README.md`.
 * @returns {{ errors: string[], workspaceCount: number }}
 */
function checkWorkspaceCoverage() {
  /** @type {string[]} */
  const errors = [];
  /** @type {Array<{ kind: string, name: string }>} */
  const workspaces = [];

  for (const kind of ["apps", "packages"]) {
    const base = path.join(ROOT, kind);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(path.join(base, entry.name, "src"))) {
        workspaces.push({ kind, name: entry.name });
      }
    }
  }

  const rootAgents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const docsIndex = readFileSync(path.join(ROOT, "docs/README.md"), "utf8");

  for (const { kind, name } of workspaces) {
    const agentsRel = `${kind}/${name}/AGENTS.md`;
    const docRel = `docs/${kind}/${name}.md`;

    if (!existsSync(path.join(ROOT, agentsRel))) {
      errors.push(`missing workspace agent guide: ${agentsRel}`);
    }
    if (!existsSync(path.join(ROOT, docRel))) {
      errors.push(`missing workspace documentation: ${docRel}`);
    }
    if (!rootAgents.includes(`./${agentsRel}`)) {
      errors.push(`AGENTS.md: missing router link to ./${agentsRel}`);
    }
    if (!docsIndex.includes(`./${kind}/${name}.md`)) {
      errors.push(`docs/README.md: missing index link to ./${kind}/${name}.md`);
    }
  }

  return { errors, workspaceCount: workspaces.length };
}

function main() {
  const files = discoverActiveMarkdownFiles();
  const linkCheck = checkMarkdownLinks(files);
  const agentsCheck = checkAgentsMdHygiene();
  const coverageCheck = checkWorkspaceCoverage();

  const errors = [...linkCheck.errors, ...agentsCheck.errors, ...coverageCheck.errors];
  if (errors.length > 0) {
    console.error(`docs:check failed with ${errors.length} error(s):`);
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(
    `docs:check passed (${files.length} files, ${linkCheck.linkCount} links, ${agentsCheck.fileCount} AGENTS.md, ${coverageCheck.workspaceCount} code workspaces).`,
  );
}

main();
