import { describe, expect, it } from "vitest";
import { ManifestParseError } from "./errors.js";
import { JsonScanError, jsonPathKey, locateJsonStrings, parseJsonWithTrailingCommas } from "./json-locate.js";
import { parsePackageJson } from "./package-json.js";

const TEXT = `{
  "name": "web",
  "packageManager": "pnpm@9.12.0",
  "workspaces": ["apps/*", "packages/*"],
  "dependencies": {
    "react": "^18.2.0",
    "@scope/pkg": "~1.2.3",
    "local": "workspace:*",
    "alias": "npm:other@^1.0.0",
    "gitdep": "github:user/repo",
    "any": "*",
    "tagged": "latest",
    "esc\\u0061ped": "1.0.0"
  },
  "devDependencies": { "typescript": "5.6.3" },
  "peerDependencies": { "react": ">=17" },
  "optionalDependencies": { "fsevents": "^2.3.3" },
  "overrides": { "minimist": "1.2.8", "nested": { ".": "1.0.0" } },
  "pnpm": { "overrides": { "semver": "^7.6.0" } }
}
`;

describe("parsePackageJson", () => {
  const manifest = parsePackageJson(TEXT, "apps/web/package.json");

  it("reads metadata", () => {
    expect(manifest.name).toBe("web");
    expect(manifest.packageManager).toBe("pnpm@9.12.0");
    expect(manifest.workspaces).toEqual(["apps/*", "packages/*"]);
  });

  it("reads every section with kinds and spans", () => {
    const react = manifest.dependencies.find((d) => d.name === "react" && d.kind === "PROD");
    expect(react).toMatchObject({ declared: "^18.2.0", supported: true, rangeSyntax: "npm", file: "apps/web/package.json" });
    expect(TEXT.slice(react!.span!.start, react!.span!.end)).toBe("^18.2.0");
    expect(manifest.dependencies.find((d) => d.name === "typescript")?.kind).toBe("DEV");
    expect(manifest.dependencies.find((d) => d.name === "react" && d.kind === "PEER")?.declared).toBe(">=17");
    expect(manifest.dependencies.find((d) => d.name === "fsevents")?.kind).toBe("OPTIONAL");
    const scoped = manifest.dependencies.find((d) => d.name === "@scope/pkg");
    expect(TEXT.slice(scoped!.span!.start, scoped!.span!.end)).toBe("~1.2.3");
  });

  it("keeps unsupported specs as UNSUPPORTED_SOURCE candidates", () => {
    for (const name of ["local", "alias", "gitdep", "any", "tagged"]) {
      const dependency = manifest.dependencies.find((d) => d.name === name);
      expect(dependency?.supported, name).toBe(false);
      expect(dependency?.unsupportedReason, name).toBeTruthy();
    }
  });

  it("lists overrides as unsupported with their table as group", () => {
    const overrides = manifest.dependencies.filter((d) => d.group !== "");
    expect(overrides.map((d) => `${d.group}:${d.name}`)).toEqual(["overrides:minimist", "pnpm.overrides:semver"]);
    expect(overrides.every((d) => !d.supported && d.span === null)).toBe(true);
  });

  it("does not give a span to escaped keys' values only when the value has escapes", () => {
    const escaped = manifest.dependencies.find((d) => d.name === "escaped");
    expect(escaped?.span).not.toBeNull();
  });

  it("handles a BOM and CRLF", () => {
    const text = `\uFEFF{\r\n  "dependencies": {\r\n    "a": "1.0.0"\r\n  }\r\n}\r\n`;
    const dependency = parsePackageJson(text).dependencies[0]!;
    expect(text.slice(dependency.span!.start, dependency.span!.end)).toBe("1.0.0");
  });

  it("throws ManifestParseError on invalid JSON", () => {
    expect(() => parsePackageJson("{ nope", "package.json")).toThrow(ManifestParseError);
    expect(() => parsePackageJson("[]", "package.json")).toThrow(ManifestParseError);
  });

  it("reads the object form of workspaces", () => {
    expect(parsePackageJson(`{"workspaces":{"packages":["libs/*"]}}`).workspaces).toEqual(["libs/*"]);
  });
});

describe("locateJsonStrings / parseJsonWithTrailingCommas", () => {
  it("handles line and block comments when allowComments is true", () => {
    const jsonc = `// header comment\n{\n  /* block comment */ "a": [1, /* inline */ "two",],\n  "b": true,\n}\n`;
    const located = locateJsonStrings(jsonc, { allowComments: true, allowTrailingCommas: true });
    const entry = located.locations.get(jsonPathKey(["a", 1]))!;
    expect(jsonc.slice(entry.span.start, entry.span.end)).toBe("two");
    expect(parseJsonWithTrailingCommas(jsonc)).toEqual({ a: [1, "two"], b: true });
    expect(() => locateJsonStrings("/* unterminated", { allowComments: true })).toThrow(JsonScanError);
    expect(() => locateJsonStrings("// comment\n{}", { allowComments: false })).toThrow(JsonScanError);
  });

  it("enforces trailing comma option and rejects malformed strings or trailing tokens", () => {
    expect(() => locateJsonStrings(`{"a": 1,}`)).toThrow(JsonScanError);
    expect(() => locateJsonStrings(`[1,]`)).toThrow(JsonScanError);
    expect(locateJsonStrings(`{"a": "ok",}`, { allowTrailingCommas: true }).locations.has(jsonPathKey(["a"]))).toBe(true);
    expect(() => locateJsonStrings(`{"a": "line\nbreak"}`)).toThrow(JsonScanError);
    expect(() => locateJsonStrings(`{"a": "\\x"}`)).toThrow(JsonScanError);
    expect(() => locateJsonStrings(`{"a": "\\u12"}`)).toThrow(JsonScanError);
    expect(() => locateJsonStrings(`{"a": "ok"} extra`)).toThrow(JsonScanError);
  });
});
