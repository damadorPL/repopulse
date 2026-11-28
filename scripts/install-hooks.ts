import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = process.cwd();
const gitDir = resolve(repoRoot, ".git");
const hooksDir = resolve(repoRoot, ".githooks");
const commitTemplate = resolve(repoRoot, ".gitmessage");

if (!existsSync(gitDir) || !existsSync(hooksDir)) {
  process.exit(0);
}

execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: repoRoot,
  stdio: "inherit",
});

console.log("[hooks:install] Configured git core.hooksPath = .githooks");

if (existsSync(commitTemplate)) {
  execFileSync("git", ["config", "commit.template", ".gitmessage"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  console.log("[hooks:install] Configured git commit.template = .gitmessage");
}
