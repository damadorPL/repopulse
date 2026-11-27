#!/usr/bin/env node
// Extracts release metadata and CHANGELOG.md notes for the version in apps/web/package.json.
//   node scripts/release-notes.mjs [--out <path>] [--github-output]

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const root = path.resolve(import.meta.dirname, "..");

let values;
try {
  ({ values } = parseArgs({
    options: {
      out: { type: "string" },
      "github-output": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  }));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (values.help) {
  console.log("Usage: node scripts/release-notes.mjs [--out <path>] [--github-output]");
  process.exit(0);
}

if (values.out === "") {
  console.error("Missing path after --out");
  process.exit(1);
}

const outPath = values.out ?? null;
const writeGithubOutput = values["github-output"];

const webPkg = JSON.parse(readFileSync(path.join(root, "apps", "web", "package.json"), "utf8"));
const version = typeof webPkg.version === "string" ? webPkg.version.trim() : "";
if (!/^\d+(?:\.\d+){2,3}(?:-[A-Za-z0-9.]+)?$/.test(version)) {
  console.error(`Invalid version in apps/web/package.json: "${version}"`);
  process.exit(1);
}

const tag = `v${version}`;
const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8").replace(/\r\n?/g, "\n");
const lines = changelog.split("\n");

function parseSectionHeading(line) {
  if (!line.startsWith("## [")) return null;
  const close = line.indexOf("]", 4);
  if (close === -1) return null;
  const headingVersion = line.slice(4, close).trim();
  const rest = line.slice(close + 1).trim();
  let summary = "";
  const match = /^[—-]\s*\d{4}-\d{2}-\d{2}\s*[—-]\s*(.+)$/.exec(rest);
  if (match) summary = match[1].trim();
  return { version: headingVersion, summary };
}

let startLine = -1;
let endLine = lines.length;
let summary = "";
let prevVersion = "";

for (let i = 0; i < lines.length; i++) {
  const parsed = parseSectionHeading(lines[i]);
  if (!parsed) continue;
  if (startLine === -1) {
    if (parsed.version === version) {
      startLine = i + 1;
      summary = parsed.summary;
    }
  } else {
    endLine = i;
    if (parsed.version && parsed.version.toLowerCase() !== "unreleased") {
      prevVersion = parsed.version;
    }
    break;
  }
}

const repoSlug = process.env.GITHUB_REPOSITORY || "damadorPL/repopulse";
let notes = "";
let hasNotes = false;
if (startLine !== -1) {
  const body = lines.slice(startLine, endLine).join("\n").trim();
  if (body) {
    hasNotes = true;
    notes = prevVersion
      ? `${body}\n\n**Full Changelog**: https://github.com/${repoSlug}/compare/v${prevVersion}...${tag}`
      : body;
  }
}

const title = summary ? `${tag} — ${summary}` : tag;

if (outPath) {
  writeFileSync(outPath, notes ? `${notes}\n` : "", "utf8");
}

if (writeGithubOutput) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.error("GITHUB_OUTPUT is not set");
    process.exit(1);
  }
  const delimiter = `EOF_${Date.now()}`;
  const block = [
    `version=${version}`,
    `tag=${tag}`,
    `title<<${delimiter}`,
    title,
    delimiter,
    `has_notes=${hasNotes ? "true" : "false"}`,
    "",
  ].join("\n");
  appendFileSync(outputFile, block, "utf8");
} else {
  console.log(JSON.stringify({ version, tag, title, prevVersion: prevVersion || null, hasNotes, notes }, null, 2));
}
