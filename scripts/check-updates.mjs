#!/usr/bin/env node
// Checks all dependencies across monorepo packages against the npm registry.
//   node scripts/check-updates.mjs
//   pnpm deps:check
//   node scripts/check-updates.mjs --outdated-only
//   node scripts/check-updates.mjs --json

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/check-updates.mjs [options]

Options:
  --outdated-only   Show only packages that have updates available
  --json            Output results as formatted JSON
  --no-fail         Always exit with code 0 even if outdated packages exist
  -h, --help        Show this help message
`);
  process.exit(0);
}

const outdatedOnly = args.has("--outdated-only");
const outputJson = args.has("--json");
const noFail = args.has("--no-fail");

/** Find all files matching a filename in a directory, ignoring node_modules, dist, .next */
function findFilesNamed(dir, filename) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".next" || entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesNamed(fullPath, filename));
    } else if (entry.isFile() && entry.name === filename) {
      results.push(fullPath);
    }
  }
  return results;
}

const packageJsonFiles = [
  path.join(root, "package.json"),
  ...findFilesNamed(path.join(root, "apps"), "package.json"),
  ...findFilesNamed(path.join(root, "packages"), "package.json"),
];

const dockerfilePaths = [
  ...findFilesNamed(path.join(root, "apps"), "Dockerfile"),
  ...findFilesNamed(path.join(root, "deploy"), "Dockerfile"),
];

// Map: pkgName -> Map<version, Set<consumer>>
const externalPackages = new Map();

function recordPackage(pkgName, version, consumer) {
  if (!externalPackages.has(pkgName)) {
    externalPackages.set(pkgName, new Map());
  }
  const versionMap = externalPackages.get(pkgName);
  if (!versionMap.has(version)) {
    versionMap.set(version, new Set());
  }
  versionMap.get(version).add(consumer);
}

for (const filePath of packageJsonFiles) {
  try {
    const content = JSON.parse(readFileSync(filePath, "utf8"));
    const consumerName = content.name || path.relative(root, filePath);

    if (typeof content.packageManager === "string" && content.packageManager.includes("@")) {
      const atIdx = content.packageManager.lastIndexOf("@");
      const pmName = content.packageManager.slice(0, atIdx);
      const pmVersion = content.packageManager.slice(atIdx + 1).split("+")[0];
      if (pmName && pmVersion) {
        recordPackage(pmName, pmVersion, `${consumerName} (packageManager)`);
      }
    }

    for (const depType of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const deps = content[depType];
      if (!deps || typeof deps !== "object") continue;

      for (const [depName, versionSpec] of Object.entries(deps)) {
        if (versionSpec.startsWith("workspace:")) continue;

        // Handle npm aliases like "typescript": "npm:@typescript/typescript6@6.0.2"
        let actualName = depName;
        let actualVersion = versionSpec;
        if (versionSpec.startsWith("npm:")) {
          const spec = versionSpec.slice(4);
          const lastAt = spec.lastIndexOf("@");
          if (lastAt > 0) {
            actualName = spec.slice(0, lastAt);
            actualVersion = spec.slice(lastAt + 1);
          } else {
            actualName = spec;
            actualVersion = "latest";
          }
        }

        recordPackage(actualName, actualVersion, consumerName);
      }
    }
  } catch (err) {
    console.error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

for (const filePath of dockerfilePaths) {
  try {
    const content = readFileSync(filePath, "utf8");
    const relPath = path.relative(root, filePath).replaceAll("\\", "/");
    // Match `npm install -g pkg@version ...` (single-line or backslash-continued)
    const normalized = content.replace(/\\\r?\n/g, " ");
    const installRegex = /\bnpm\s+(?:install|i)\s+[^\n]*?-g\s+([^\n&|;]+)/g;
    for (const match of normalized.matchAll(installRegex)) {
      const tokens = match[1].trim().split(/\s+/);
      for (const token of tokens) {
        if (token.startsWith("-")) continue;
        const clean = token.replace(/^["']|["']$/g, "");
        const lastAt = clean.lastIndexOf("@");
        if (lastAt <= 0) continue;
        const pkgName = clean.slice(0, lastAt);
        const version = clean.slice(lastAt + 1);
        // Skip shell variable substitutions like ${NPM_VERSION} (checked by check-sandbox-updates.mjs)
        if (!version || version.includes("$")) continue;
        recordPackage(pkgName, version, relPath);
      }
    }
  } catch (err) {
    console.error(`Failed to read ${filePath}: ${err.message}`);
  }
}

function encodePkgName(name) {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.split("/");
    return `${scope}/${pkg}`;
  }
  return name;
}

async function fetchLatestInfo(pkgName) {
  const url = `https://registry.npmjs.org/${encodePkgName(pkgName)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
      },
    });

    if (!res.ok) {
      return { name: pkgName, error: `HTTP ${res.status}: ${res.statusText}` };
    }

    const data = await res.json();
    const distTags = data["dist-tags"] || {};
    const latest = distTags.latest;

    return {
      name: pkgName,
      latest,
      distTags,
    };
  } catch (err) {
    return {
      name: pkgName,
      error: err.message,
    };
  }
}

// Concurrency pool to fetch package info quickly
async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await fn(current));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

if (!outputJson) {
  console.log(`Checking ${externalPackages.size} unique packages across workspace...\n`);
}

const packageNames = Array.from(externalPackages.keys()).sort();
const registryResults = await mapConcurrent(packageNames, 10, fetchLatestInfo);

const report = [];

for (const res of registryResults) {
  const versionMap = externalPackages.get(res.name);
  const currentVersions = Array.from(versionMap.keys());
  const dependents = Array.from(new Set(Array.from(versionMap.values()).flatMap((s) => Array.from(s))));

  if (res.error) {
    report.push({
      package: res.name,
      status: "error",
      current: currentVersions.join(", "),
      latest: "N/A",
      error: res.error,
      dependents,
    });
    continue;
  }

  const isUpToDate = currentVersions.every((v) => {
    if (v === res.latest) return true;
    // Check if current version matches another dist-tag (e.g. beta, rc)
    if (res.distTags && Object.values(res.distTags).includes(v)) return true;
    return false;
  });

  report.push({
    package: res.name,
    status: isUpToDate ? "up-to-date" : "outdated",
    current: currentVersions.join(", "),
    latest: res.latest,
    distTags: res.distTags,
    dependents,
  });
}

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const outdated = report.filter((r) => r.status === "outdated");
const upToDate = report.filter((r) => r.status === "up-to-date");
const errors = report.filter((r) => r.status === "error");

if (outdated.length > 0) {
  console.log("OUTDATED PACKAGES:");
  for (const item of outdated) {
    const depsStr = item.dependents.join(", ");
    console.log(`  ✖ ${item.package}: ${item.current} → ${item.latest} (used in: ${depsStr})`);
  }
  console.log("");
}

if (!outdatedOnly) {
  console.log(`UP-TO-DATE PACKAGES (${upToDate.length}):`);
  for (const item of upToDate) {
    console.log(`  ✔ ${item.package} (${item.current})`);
  }
  console.log("");
}

if (errors.length > 0) {
  console.log(`ERRORS CHECKING (${errors.length}):`);
  for (const item of errors) {
    console.log(`  ! ${item.package}: ${item.error}`);
  }
  console.log("");
}

console.log(`Summary: ${upToDate.length} up-to-date, ${outdated.length} outdated, ${errors.length} errors.`);

if (outdated.length > 0 && !noFail) {
  process.exit(1);
}
