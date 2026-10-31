#!/usr/bin/env node
// Adds settings introduced by later slices to existing env files, without touching values
// that are already there. Safe to run repeatedly.
//   pnpm env:sync                      # updates .env.example and .env (if present)
//   pnpm env:sync --check              # only reports what is missing; exit code 1 if anything is
//   pnpm env:sync path/to/file.env     # specific files instead of the defaults
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Each entry is inserted after the line defining `after` (or appended at the end of the file
 * when that key is missing). A key counts as present whether it is set or commented out
 * (`# KEY=`), so a deliberately disabled setting is never re-added.
 */
const ADDITIONS = [
  {
    key: "REPO_POLL_CONCURRENCY",
    after: "POLL_INTERVAL_CRON",
    lines: [
      "# Optional: parallel repository polls / notification jobs per worker process.",
      "# REPO_POLL_CONCURRENCY=5",
    ],
  },
  {
    key: "NOTIFICATION_CONCURRENCY",
    after: "REPO_POLL_CONCURRENCY",
    lines: ["# NOTIFICATION_CONCURRENCY=10"],
  },
  {
    key: "RELEASE_BACKFILL_DEFAULT_TARGET",
    after: "NOTIFICATION_CONCURRENCY",
    lines: [
      "# Optional: background import of older releases (defaults shown). MAX_AGE_DAYS=0 means no age limit.",
      "# RELEASE_BACKFILL_DEFAULT_TARGET=100",
    ],
  },
  { key: "RELEASE_BACKFILL_MAX_AGE_DAYS", after: "RELEASE_BACKFILL_DEFAULT_TARGET", lines: ["# RELEASE_BACKFILL_MAX_AGE_DAYS=365"] },
  { key: "RELEASE_BACKFILL_HARD_CAP", after: "RELEASE_BACKFILL_MAX_AGE_DAYS", lines: ["# RELEASE_BACKFILL_HARD_CAP=1000"] },
  { key: "RELEASE_BACKFILL_MIN_QUOTA", after: "RELEASE_BACKFILL_HARD_CAP", lines: ["# RELEASE_BACKFILL_MIN_QUOTA=500"] },
];

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const explicitFiles = args.filter((arg) => !arg.startsWith("--"));
const files = explicitFiles.length
  ? explicitFiles.map((file) => path.resolve(file))
  : [path.join(root, ".env.example"), path.join(root, ".env")];

const definesKey = (line, key) => new RegExp(`^\\s*(#\\s*)?${key}=`).test(line);

/** Returns the updated text and the keys that were added. */
function sync(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const added = [];

  for (const { key, after, lines: block } of ADDITIONS) {
    if (lines.some((line) => definesKey(line, key))) continue;
    const anchor = lines.findLastIndex((line) => definesKey(line, after));
    if (anchor === -1) {
      // Append before the trailing empty line produced by a final newline.
      const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
      lines.splice(end, 0, ...block);
    } else {
      lines.splice(anchor + 1, 0, ...block);
    }
    added.push(key);
  }
  return { text: lines.join(eol), added };
}

let missingAnything = false;
for (const file of files) {
  const relative = path.relative(root, file);
  const label = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
  if (!existsSync(file)) {
    if (explicitFiles.length) {
      console.error(`✖ ${label} does not exist`);
      process.exitCode = 1;
    } else {
      console.log(`- ${label}: not found, skipped`);
    }
    continue;
  }

  const { text, added } = sync(readFileSync(file, "utf8"));
  if (added.length === 0) {
    console.log(`✔ ${label}: up to date`);
    continue;
  }
  missingAnything = true;
  if (checkOnly) {
    console.log(`✖ ${label}: missing ${added.join(", ")}`);
  } else {
    writeFileSync(file, text);
    console.log(`✔ ${label}: added ${added.join(", ")}`);
  }
}

if (checkOnly && missingAnything) process.exitCode = 1;
