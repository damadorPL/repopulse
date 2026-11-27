import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const gitDir = resolve(repoRoot, ".git");
const hooksDir = resolve(repoRoot, ".githooks");

if (!existsSync(gitDir) || !existsSync(hooksDir)) {
  process.exit(0);
}

execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log("[hooks:install] Configured git core.hooksPath = .githooks");
