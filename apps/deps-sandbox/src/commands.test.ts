import { describe, expect, it, vi } from "vitest";
import {
  buildCommands,
  checkToolVersions,
  declaredPackageManagers,
  isValidNpmName,
  isValidPythonName,
  isValidVersion,
  lockfileFormat,
  LockJobError,
  rangeAllowsMajor,
  validateUpgrades,
  type ToolVersions,
} from "./commands.js";

const TOOLS: ToolVersions = { npm: "12.2.2", pnpm: "12.16.1", bun: "1.4.4", uv: "0.13.7", poetry: "2.5.1" };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof LockJobError) return err.code;
    throw err;
  }
}

describe("package name validation", () => {
  it("accepts npm names, scoped names and legacy uppercase names", () => {
    for (const name of ["react", "@types/node", "lodash.merge", "JSONStream", "@scope/a-b_c~d", "7zip-bin"]) {
      expect(isValidNpmName(name)).toBe(true);
    }
  });

  it("rejects anything that could be parsed as a flag or a path", () => {
    for (const name of [
      "-g",
      "--registry=http://evil",
      "@scope/-x",
      ".hidden",
      "_private",
      "a b",
      "../x",
      "a/b",
      "@/x",
      "x@1.0.0",
      "",
      "a".repeat(215),
      "file:../x",
    ]) {
      expect(isValidNpmName(name)).toBe(false);
    }
  });

  it("validates PEP 508 names", () => {
    for (const name of ["requests", "Django", "zope.interface", "typing_extensions", "a", "a-1"]) {
      expect(isValidPythonName(name)).toBe(true);
    }
    for (const name of ["-r", "--index-url", "a-", "_a", "a b", "a==1", "a;b", "x[extra]"]) {
      expect(isValidPythonName(name)).toBe(false);
    }
  });

  it("validates versions", () => {
    for (const v of ["1.2.3", "1.0.0-beta.1", "2.0.0rc1", "1!2.0", "1.0+local.1", "v1.2.3"]) {
      expect(isValidVersion(v)).toBe(true);
    }
    for (const v of ["-1", "--x", "1 2", "", ">=1", "1.0;rm"]) expect(isValidVersion(v)).toBe(false);
  });

  it("dedupes upgrades (PEP 503 normalization for Python) and rejects bad entries", () => {
    expect(
      validateUpgrades("UV", [
        { name: "Typing_Extensions", version: "4.12.0" },
        { name: "typing-extensions", version: "4.13.0" },
        { name: "typing.extensions", version: "4.14.0" },
        { name: "typing--extensions", version: "4.15.0" },
      ]),
    ).toEqual([{ name: "Typing_Extensions", version: "4.12.0" }]);
    expect(codeOf(() => validateUpgrades("NPM", [{ name: "--global", version: "1.0.0" }]))).toBe("BAD_REQUEST");
    expect(codeOf(() => validateUpgrades("UV", [{ name: "ok", version: "--x" }]))).toBe("BAD_REQUEST");
  });
});

describe("buildCommands", () => {
  const plain = { workspace: false };

  it("npm install / update", () => {
    expect(buildCommands({ packageManager: "NPM", upgrade: [], lockfileOnly: false }, plain)).toEqual([
      { command: "npm", args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"] },
    ]);
    expect(
      buildCommands(
        { packageManager: "NPM", upgrade: [{ name: "@types/node", version: "26.1.0" }], lockfileOnly: true },
        plain,
      ),
    ).toEqual([
      {
        command: "npm",
        args: ["update", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "@types/node"],
      },
    ]);
  });

  it("pnpm install / update (recursive in a workspace, never saving ranges)", () => {
    expect(buildCommands({ packageManager: "PNPM", upgrade: [], lockfileOnly: false }, plain)).toEqual([
      {
        command: "pnpm",
        args: ["install", "--no-frozen-lockfile", "--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile"],
      },
    ]);
    const [step] = buildCommands(
      { packageManager: "PNPM", upgrade: [{ name: "zod", version: "4.6.7" }], lockfileOnly: true },
      { workspace: true },
    );
    expect(step!.args).toEqual([
      "update",
      "--recursive",
      "--no-save",
      "--lockfile-only",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "zod",
    ]);
  });

  it("bun install, and update + manifest restore + install for lockfileOnly (with --recursive in workspaces)", () => {
    expect(buildCommands({ packageManager: "BUN", upgrade: [], lockfileOnly: false }, plain)).toEqual([
      { command: "bun", args: ["install", "--lockfile-only", "--ignore-scripts", "--no-env-file"] },
    ]);
    const steps = buildCommands(
      { packageManager: "BUN", upgrade: [{ name: "ms", version: "2.1.3" }], lockfileOnly: true },
      plain,
    );
    expect(steps).toEqual([
      { command: "bun", args: ["update", "--lockfile-only", "--ignore-scripts", "--no-env-file", "ms"] },
      {
        command: "bun",
        args: ["install", "--lockfile-only", "--ignore-scripts", "--no-env-file"],
        restoreManifests: true,
      },
    ]);
    const wsSteps = buildCommands(
      { packageManager: "BUN", upgrade: [{ name: "ms", version: "2.1.3" }], lockfileOnly: true },
      { workspace: true },
    );
    expect(wsSteps[0]!.args).toEqual(["update", "--recursive", "--lockfile-only", "--ignore-scripts", "--no-env-file", "ms"]);
    expect(wsSteps[1]).toMatchObject({ restoreManifests: true });
  });

  it("uv: one --upgrade-package name==version per upgrade", () => {
    expect(
      buildCommands(
        {
          packageManager: "UV",
          upgrade: [
            { name: "requests", version: "2.33.0" },
            { name: "ruff", version: "0.14.2" },
          ],
          lockfileOnly: true,
        },
        plain,
      ),
    ).toEqual([
      {
        command: "uv",
        args: ["lock", "--upgrade-package", "requests==2.33.0", "--upgrade-package", "ruff==0.14.2"],
      },
    ]);
    expect(buildCommands({ packageManager: "UV", upgrade: [], lockfileOnly: false }, plain)).toEqual([
      { command: "uv", args: ["lock"] },
    ]);
  });

  it("poetry lock / update --lock, plugins disabled", () => {
    expect(buildCommands({ packageManager: "POETRY", upgrade: [], lockfileOnly: false }, plain)).toEqual([
      { command: "poetry", args: ["--no-plugins", "--no-interaction", "--no-ansi", "lock"] },
    ]);
    expect(
      buildCommands(
        { packageManager: "POETRY", upgrade: [{ name: "django", version: "5.3.0" }], lockfileOnly: true },
        plain,
      )[0]!.args,
    ).toEqual(["--no-plugins", "--no-interaction", "--no-ansi", "update", "--lock", "django"]);
  });

  it("refuses lockfileOnly without names for NPM/PNPM/BUN/POETRY, allows it for UV, and refuses names that look like flags", () => {
    expect(codeOf(() => buildCommands({ packageManager: "NPM", upgrade: [], lockfileOnly: true }, plain))).toBe(
      "BAD_REQUEST",
    );
    expect(codeOf(() => buildCommands({ packageManager: "POETRY", upgrade: [], lockfileOnly: true }, plain))).toBe(
      "BAD_REQUEST",
    );
    expect(buildCommands({ packageManager: "UV", upgrade: [], lockfileOnly: true }, plain)).toEqual([
      { command: "uv", args: ["lock"] },
    ]);
    expect(
      codeOf(() =>
        buildCommands(
          { packageManager: "PNPM", upgrade: [{ name: "-r", version: "1.0.0" }], lockfileOnly: true },
          plain,
        ),
      ),
    ).toBe("BAD_REQUEST");
  });

  it("only ever produces argument arrays of plain strings", () => {
    for (const pm of ["NPM", "PNPM", "BUN", "UV", "POETRY"] as const) {
      const upgrade = [{ name: pm === "UV" || pm === "POETRY" ? "requests" : "react", version: "1.0.0" }];
      for (const step of buildCommands({ packageManager: pm, upgrade, lockfileOnly: true }, plain)) {
        expect(step.args.every((arg) => typeof arg === "string" && !/[;&|`$]/.test(arg))).toBe(true);
      }
    }
  });
});

describe("tool version checks", () => {
  it("rangeAllowsMajor", () => {
    expect(rangeAllowsMajor("12.16.1", 12)).toBe(true);
    expect(rangeAllowsMajor("10.12.1", 12)).toBe(false);
    expect(rangeAllowsMajor("^12", 12)).toBe(true);
    expect(rangeAllowsMajor("~11.2.0", 12)).toBe(false);
    expect(rangeAllowsMajor(">=10", 12)).toBe(true);
    expect(rangeAllowsMajor(">=13.0.0", 12)).toBe(false);
    expect(rangeAllowsMajor(">=10 <12", 12)).toBe(false);
    expect(rangeAllowsMajor(">=10 <12.1", 12)).toBe(true);
    expect(rangeAllowsMajor("^10 || ^12", 12)).toBe(true);
    expect(rangeAllowsMajor("*", 12)).toBe(true);
    expect(rangeAllowsMajor("12.x", 12)).toBe(true);
  });

  it("reads packageManager and devEngines.packageManager (array, missing version, unknown manager)", () => {
    expect(
      declaredPackageManagers(
        JSON.stringify({
          packageManager: "pnpm@10.12.1+sha512.abc",
          devEngines: {
            packageManager: [{ name: "pnpm", version: "^10" }, { name: "npm" }, { name: "custom-pm", version: "1.0.0" }],
          },
        }),
      ),
    ).toEqual([
      { name: "pnpm", version: "10.12.1" },
      { name: "pnpm", version: "^10" },
      { name: "npm", version: "*" },
      { name: "custom-pm", version: "1.0.0" },
    ]);
    // Unknown manager in devEngines is ignored, missing version defaults to "*" which allows any installed major
    const unknownAndWildcard = JSON.stringify({
      devEngines: { packageManager: [{ name: "custom-pm", version: "99.0.0" }, { name: "npm" }] },
    });
    expect(codeOf(() => checkToolVersions({ packageManager: "NPM", packageJson: unknownAndWildcard }, TOOLS))).toBeNull();
  });

  it("refuses a packageManager major different from the installed tool", () => {
    const pkg = (packageManager: string) => JSON.stringify({ name: "x", packageManager });
    expect(codeOf(() => checkToolVersions({ packageManager: "PNPM", packageJson: pkg("pnpm@10.12.1") }, TOOLS))).toBe(
      "UNSUPPORTED_TOOL_VERSION",
    );
    expect(codeOf(() => checkToolVersions({ packageManager: "PNPM", packageJson: pkg("pnpm@12.16.1") }, TOOLS))).toBe(
      null,
    );
    expect(codeOf(() => checkToolVersions({ packageManager: "NPM", packageJson: pkg("npm@11.6.0") }, TOOLS))).toBe(
      "UNSUPPORTED_TOOL_VERSION",
    );
    expect(codeOf(() => checkToolVersions({ packageManager: "NPM", packageJson: pkg("yarn@4.5.0") }, TOOLS))).toBe(
      "UNSUPPORTED_TOOL_VERSION",
    );
    expect(codeOf(() => checkToolVersions({ packageManager: "BUN", packageJson: pkg("bun@1.2.0") }, TOOLS))).toBe(
      null,
    );
    const devEngines = JSON.stringify({ devEngines: { packageManager: { name: "npm", version: ">=13" } } });
    expect(codeOf(() => checkToolVersions({ packageManager: "NPM", packageJson: devEngines }, TOOLS))).toBe(
      "UNSUPPORTED_TOOL_VERSION",
    );
  });

  it("refuses a missing tool and invalid package.json", () => {
    expect(codeOf(() => checkToolVersions({ packageManager: "UV" }, { ...TOOLS, uv: "missing" }))).toBe(
      "UNSUPPORTED_TOOL_VERSION",
    );
    expect(codeOf(() => checkToolVersions({ packageManager: "NPM", packageJson: "{" }, TOOLS))).toBe("BAD_REQUEST");
  });

  it("refuses lockfile formats the pinned tools would rewrite", () => {
    const check = (pm: Parameters<typeof checkToolVersions>[0]["packageManager"], lockfile: string) =>
      codeOf(() => checkToolVersions({ packageManager: pm, lockfile }, TOOLS));

    expect(check("NPM", '{\n  "name": "x",\n  "lockfileVersion": 1,\n}')).toBe("UNSUPPORTED_TOOL_VERSION");
    expect(check("NPM", '{\n  "name": "x",\n  "lockfileVersion": 3,\n}')).toBe(null);
    expect(check("PNPM", "lockfileVersion: '6.0'\n")).toBe("UNSUPPORTED_TOOL_VERSION");
    expect(check("PNPM", "---\nlockfileVersion: '9.0'\n\nimporters: {}\n")).toBe(null);
    expect(check("PNPM", "---\nlockfileVersion: '9.0'\n---\nlockfileVersion: '9.0'\n")).toBe(null);
    expect(check("PNPM", "---\nlockfileVersion: '9.0'\n---\nlockfileVersion: '6.0'\n")).toBe("UNSUPPORTED_TOOL_VERSION");
    expect(check("BUN", '{\n  "lockfileVersion": 1,\n  "workspaces": {}\n}')).toBe(null);
    expect(check("BUN", '{\n  "lockfileVersion": 0,\n}')).toBe("UNSUPPORTED_TOOL_VERSION");
    expect(check("UV", "version = 1\nrevision = 3\nrequires-python = \">=3.12\"\n")).toBe(null);
    expect(check("UV", "version = 2\n")).toBe("UNSUPPORTED_TOOL_VERSION");
    expect(check("POETRY", '[[package]]\nname = "a"\n\n[metadata]\nlock-version = "2.1"\n')).toBe(null);
    expect(check("POETRY", '[metadata]\nlock-version = "1.1"\n')).toBe("UNSUPPORTED_TOOL_VERSION");
    expect(check("POETRY", "garbage")).toBe("UNSUPPORTED_TOOL_VERSION");
  });

  it("lockfileFormat reads each format", () => {
    expect(lockfileFormat("PNPM", "---\nlockfileVersion: '9.0'\n")).toBe("9.0");
    expect(
      lockfileFormat(
        "PNPM",
        "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies: {}\n---\nlockfileVersion: '9.0'\nimporters:\n  .: {}\n",
      ),
    ).toBe("9.0");
    expect(
      lockfileFormat(
        "PNPM",
        "---\nlockfileVersion: '9.0'\n---\nlockfileVersion: '6.0'\n",
      ),
    ).toBeNull();
    expect(lockfileFormat("NPM", '{"lockfileVersion": 2}')).toBe("2");
    expect(lockfileFormat("POETRY", 'x\n[metadata]\nlock-version = "2.1"\n')).toBe("2.1");
  });
});

describe("tool detection", () => {
  it("parses --version outputs and marks failures as missing", async () => {
    const { detectToolVersions, parseVersionOutput } = await import("./tools.js");
    expect(parseVersionOutput("uv 0.13.7 (316c827e0 2026-11-03 x86_64-unknown-linux-gnu)")).toBe("0.13.7");
    expect(parseVersionOutput("Poetry (version 2.5.1)")).toBe("2.5.1");
    expect(parseVersionOutput("12.16.1\n")).toBe("12.16.1");
    expect(parseVersionOutput("nothing")).toBeNull();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tools = await detectToolVersions(async (tool) => {
      if (tool === "poetry") throw new Error("ENOENT");
      return tool === "uv" ? "uv 0.13.7" : "1.2.3\n";
    });
    expect(tools).toEqual({ npm: "1.2.3", pnpm: "1.2.3", bun: "1.2.3", uv: "0.13.7", poetry: "missing" });
    errors.mockRestore();
  });
});
