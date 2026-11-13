#!/usr/bin/env node
// Checks pinned runtime tool versions in apps/deps-sandbox/Dockerfile against upstream registries/releases.
//   node scripts/check-sandbox-updates.mjs
//   pnpm deps:sandbox:check
//   node scripts/check-sandbox-updates.mjs --outdated-only
//   node scripts/check-sandbox-updates.mjs --json

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dockerfilePath = path.join(root, "apps", "deps-sandbox", "Dockerfile");

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/check-sandbox-updates.mjs [options]

Options:
  --outdated-only   Show only tools that have updates available
  --json            Output results as formatted JSON
  --no-fail         Always exit with code 0 even if outdated tools exist
  -h, --help        Show this help message
`);
  process.exit(0);
}

const outdatedOnly = args.has("--outdated-only");
const outputJson = args.has("--json");
const noFail = args.has("--no-fail");

const dockerfileContent = readFileSync(dockerfilePath, "utf8");

function readArg(name) {
  const match = dockerfileContent.match(new RegExp(`^ARG\\s+${name}=([^\\s#]+)`, "m"));
  return match ? match[1].trim() : null;
}

const tools = [
  {
    name: "npm",
    arg: "NPM_VERSION",
    current: readArg("NPM_VERSION"),
    source: "npm",
    fetchLatest: async () => {
      const res = await fetch("https://registry.npmjs.org/npm/latest");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return { latest: data.version };
    },
  },
  {
    name: "pnpm",
    arg: "PNPM_VERSION",
    current: readArg("PNPM_VERSION"),
    source: "npm",
    fetchLatest: async () => {
      const res = await fetch("https://registry.npmjs.org/pnpm/latest");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return { latest: data.version };
    },
  },
  {
    name: "bun",
    arg: "BUN_VERSION",
    current: readArg("BUN_VERSION"),
    source: "npm",
    fetchLatest: async () => {
      const res = await fetch("https://registry.npmjs.org/bun/latest");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return { latest: data.version };
    },
  },
  {
    name: "poetry",
    arg: "POETRY_VERSION",
    current: readArg("POETRY_VERSION"),
    source: "pypi",
    fetchLatest: async () => {
      const res = await fetch("https://pypi.org/pypi/poetry/json");
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return { latest: data.info?.version };
    },
  },
  {
    name: "uv",
    arg: "UV_VERSION",
    current: readArg("UV_VERSION"),
    source: "github",
    fetchLatest: async () => {
      const res = await fetch("https://api.github.com/repos/astral-sh/uv/releases/latest", {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      const latest = String(data.tag_name || "").replace(/^v/, "");
      return { latest };
    },
  },
];

if (!outputJson) {
  console.log(`Checking ${tools.length} sandbox runtime pins in apps/deps-sandbox/Dockerfile...\n`);
}

const report = await Promise.all(
  tools.map(async (tool) => {
    if (!tool.current) {
      return {
        tool: tool.name,
        arg: tool.arg,
        status: "error",
        current: "missing",
        latest: "N/A",
        source: tool.source,
        error: `Missing ARG ${tool.arg} in apps/deps-sandbox/Dockerfile`,
      };
    }

    try {
      const { latest } = await tool.fetchLatest();
      if (!latest) {
        return {
          tool: tool.name,
          arg: tool.arg,
          status: "error",
          current: tool.current,
          latest: "N/A",
          source: tool.source,
          error: "Could not determine latest version from upstream response",
        };
      }

      return {
        tool: tool.name,
        arg: tool.arg,
        status: tool.current === latest ? "up-to-date" : "outdated",
        current: tool.current,
        latest,
        source: tool.source,
      };
    } catch (err) {
      return {
        tool: tool.name,
        arg: tool.arg,
        status: "error",
        current: tool.current,
        latest: "N/A",
        source: tool.source,
        error: err.message,
      };
    }
  })
);

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const outdated = report.filter((r) => r.status === "outdated");
const upToDate = report.filter((r) => r.status === "up-to-date");
const errors = report.filter((r) => r.status === "error");

if (outdated.length > 0) {
  console.log("OUTDATED SANDBOX TOOLS:");
  for (const item of outdated) {
    console.log(`  ✖ ${item.tool}: ${item.current} → ${item.latest} (${item.arg}, source: ${item.source})`);
  }
  console.log("");
}

if (!outdatedOnly) {
  console.log(`UP-TO-DATE SANDBOX TOOLS (${upToDate.length}):`);
  for (const item of upToDate) {
    console.log(`  ✔ ${item.tool} (${item.current})`);
  }
  console.log("");
}

if (errors.length > 0) {
  console.log(`ERRORS CHECKING (${errors.length}):`);
  for (const item of errors) {
    console.log(`  ! ${item.tool}: ${item.error}`);
  }
  console.log("");
}

console.log(`Summary: ${upToDate.length} up-to-date, ${outdated.length} outdated, ${errors.length} errors.`);

if (outdated.length > 0 && !noFail) {
  process.exit(1);
}
