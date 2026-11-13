/**
 * Installed tool versions, detected once at startup with `<tool> --version` (reported by `GET /health` and used
 * for the `UNSUPPORTED_TOOL_VERSION` checks).
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { MISSING, TOOL_NAMES, type ToolName, type ToolVersions } from "./commands.js";

const VERSION_TIMEOUT_MS = 15_000;

/** First `x.y.z` in a `--version` output (`10.9.2`, `uv 0.13.1 (…)`, `Poetry (version 2.5.1)`). */
export function parseVersionOutput(output: string): string | null {
  const match = /\b(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)\b/.exec(output);
  return match ? match[1]! : null;
}

export type VersionRunner = (tool: ToolName) => Promise<string>;

/**
 * `<tool> --version` from an empty dir. Run from the app dir, pnpm would read the monorepo's own `packageManager`
 * field and try to download that pnpm version (and hang on the blocked network), hence `pm_on_fail=ignore`
 * (pnpm 11+) and `manage_package_manager_versions=false` (older pnpm), as in the jobs.
 */
const defaultRunner: VersionRunner = (tool) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(tool, ["--version"], {
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // Same isolation as the jobs: no inherited secrets.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? os.tmpdir(),
        NO_COLOR: "1",
        CI: "1",
        npm_config_manage_package_manager_versions: "false",
        pnpm_config_manage_package_manager_versions: "false",
        pnpm_config_pm_on_fail: "ignore",
      },
    });
    let output = "";
    const append = (chunk: Buffer) => {
      if (output.length < 64 * 1024) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${VERSION_TIMEOUT_MS}ms`));
    }, VERSION_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`exited with code ${code}`));
    });
  });

export async function detectToolVersions(run: VersionRunner = defaultRunner): Promise<ToolVersions> {
  const entries = await Promise.all(
    TOOL_NAMES.map(async (tool): Promise<[ToolName, string]> => {
      try {
        return [tool, parseVersionOutput(await run(tool)) ?? MISSING];
      } catch (err) {
        console.error(`[deps-sandbox] ${tool} --version failed: ${err instanceof Error ? err.message : String(err)}`);
        return [tool, MISSING];
      }
    }),
  );
  return Object.fromEntries(entries) as ToolVersions;
}
