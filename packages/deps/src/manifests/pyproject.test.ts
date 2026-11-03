import { describe, expect, it } from "vitest";
import { ManifestParseError } from "./errors.js";
import { parsePyproject } from "./pyproject.js";
import { locateTomlStrings, tomlPathKey } from "./toml-locate.js";

const PEP621 = `[project]
name = "demo"
requires-python = ">=3.10"
dependencies = [
  "httpx>=0.27,<1",  # comment, with ] and "quotes"
  'rich[jupyter]==13.7.1 ; python_version >= "3.10"',
  "pkg @ https://example.com/pkg.whl",
  "esc\\u0061ped>=1",
]

[project.optional-dependencies]
docs = ["mkdocs~=1.5"]

[dependency-groups]
dev = ["pytest>=8", { include-group = "docs" }]

[tool.uv]
dev-dependencies = ["ruff==0.6.0"]

[tool.uv.workspace]
members = ["packages/*"]
`;

const POETRY = `[tool.poetry]
name = "demo"

[tool.poetry.dependencies]
python = "^3.11"
Django = "^5.0"
requests = { version = "^2.31", extras = ["socks"] }
mylib = { git = "https://github.com/a/b.git" }
private = { version = "^1", source = "internal" }
multi = [{ version = "^1", python = "<3.12" }, { version = "^2", python = ">=3.12" }]
"quoted.name" = '1.0.0'

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"

[tool.poetry.dev-dependencies]
black = "*"
`;

describe("parsePyproject (PEP 621 / PEP 735 / uv)", () => {
  const manifest = parsePyproject(PEP621);

  it("reads metadata", () => {
    expect(manifest.projectName).toBe("demo");
    expect(manifest.requiresPython).toBe(">=3.10");
    expect(manifest.hasToolUv).toBe(true);
    expect(manifest.hasToolPoetry).toBe(false);
    expect(manifest.uvWorkspace).toEqual({ members: ["packages/*"], exclude: [] });
  });

  it("reads every table with spans inside the strings", () => {
    const summary = manifest.dependencies.map((d) => [d.name, d.kind, d.group, d.declared, d.supported]);
    expect(summary).toEqual([
      ["httpx", "PROD", "", ">=0.27,<1", true],
      ["rich", "PROD", "", "==13.7.1", true],
      ["pkg", "PROD", "", "@ https://example.com/pkg.whl", false],
      ["escaped", "PROD", "", ">=1", true],
      ["mkdocs", "GROUP", "docs", "~=1.5", true],
      ["pytest", "GROUP", "dev", ">=8", true],
      ["ruff", "DEV", "", "==0.6.0", true],
    ]);
    for (const dependency of manifest.dependencies) {
      if (dependency.span) expect(PEP621.slice(dependency.span.start, dependency.span.end)).toBe(dependency.declared);
    }
    expect(manifest.dependencies.find((d) => d.name === "escaped")!.span).toBeNull();
    expect(manifest.dependencies.find((d) => d.name === "rich")!.marker).toBe('python_version >= "3.10"');
    expect(manifest.dependencies.find((d) => d.name === "rich")!.rangeSyntax).toBe("pep440");
  });
});

describe("parsePyproject (Poetry)", () => {
  const manifest = parsePyproject(POETRY);

  it("reads Poetry tables, skipping python", () => {
    expect(manifest.hasToolPoetry).toBe(true);
    expect(manifest.requiresPython).toBe("^3.11");
    expect(manifest.requiresPythonSyntax).toBe("poetry");
    const summary = manifest.dependencies.map((d) => [d.name, d.kind, d.group, d.declared, d.supported]);
    expect(summary).toEqual([
      ["django", "PROD", "", "^5.0", true],
      ["requests", "PROD", "", "^2.31", true],
      ["mylib", "PROD", "", "", false],
      ["private", "PROD", "", "^1", false],
      ["multi", "PROD", "", "", false],
      ["quoted-name", "PROD", "", "1.0.0", true],
      ["black", "DEV", "", "*", true],
      ["pytest", "GROUP", "dev", "^8.0", true],
    ]);
    for (const dependency of manifest.dependencies) {
      if (dependency.span) expect(POETRY.slice(dependency.span.start, dependency.span.end)).toBe(dependency.declared);
    }
    expect(manifest.dependencies[1]!.valuePath).toEqual(["tool", "poetry", "dependencies", "requests", "version"]);
    expect(manifest.dependencies[0]!.rangeSyntax).toBe("poetry");
  });

  it("throws ManifestParseError on invalid TOML", () => {
    expect(() => parsePyproject("[project\nname=", "pyproject.toml")).toThrow(ManifestParseError);
  });
});

describe("locateTomlStrings", () => {
  it("handles multi-line strings, array tables, dotted keys, dates and inline tables", () => {
    const text = `title = """multi
line"""
date = 1979-05-27 07:32:00Z
a.b."c.d" = 'x'
[[bin]]
name = "first"
[[bin]]
name = "second"
[t]
inline = { k = { deep = "v" }, arr = [1, "two"] }
`;
    const located = locateTomlStrings(text);
    const at = (path: Array<string | number>): string => {
      const loc = located.get(tomlPathKey(path))!;
      return text.slice(loc.span.start, loc.span.end);
    };
    expect(at(["a", "b", "c.d"])).toBe("x");
    expect(at(["bin", 1, "name"])).toBe("second");
    expect(at(["t", "inline", "k", "deep"])).toBe("v");
    expect(at(["t", "inline", "arr", 1])).toBe("two");
    expect(located.get(tomlPathKey(["title"]))!.plain).toBe(false);
  });
});
