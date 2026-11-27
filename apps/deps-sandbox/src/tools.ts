/**
 * Installed tool versions, detected once at startup with `<tool> --version` (reported by `GET /health` and used
 * for the `UNSUPPORTED_TOOL_VERSION` checks).
 */
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { MISSING, TOOL_NAMES, type ToolName, type ToolVersions } from "./commands.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);
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
const defaultRunner: VersionRunner = async (tool) => {
  const { stdout, stderr } = await execFileAsync(tool, ["--version"], {
    cwd: os.tmpdir(),
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
    timeout: VERSION_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  return `${stdout}${stderr}`;
};

export async function detectToolVersions(run: VersionRunner = defaultRunner): Promise<ToolVersions> {
  const entries = await Promise.all(
    TOOL_NAMES.map(async (tool): Promise<[ToolName, string]> => {
      try {
        return [tool, parseVersionOutput(await run(tool)) ?? MISSING];
      } catch (err) {
        log.error({ tool, err }, `${tool} --version failed`);
        return [tool, MISSING];
      }
    }),
  );
  return Object.fromEntries(entries) as ToolVersions;
}
