import { describe, expect, it } from "vitest";
import { applyRegistryPolicy, registryConfigPaths } from "./registry-config.js";
import type { DependencyEcosystem, ParsedDependency } from "./types.js";

function dep(name: string, ecosystem: DependencyEcosystem = "NPM"): ParsedDependency {
  return {
    name,
    rawName: name,
    kind: "PROD",
    group: "",
    declared: "1.0.0",
    rangeSyntax: ecosystem === "NPM" ? "npm" : "pep440",
    span: null,
    supported: true,
    file: ecosystem === "NPM" ? "package.json" : "pyproject.toml",
  };
}

function check(
  ecosystem: DependencyEcosystem,
  files: Record<string, string | null>,
  names: string[] = ecosystem === "NPM" ? ["@scope/pkg", "react"] : ["requests", "internal-pkg"],
  path = ecosystem === "NPM" ? "package.json" : "pyproject.toml",
): Record<string, boolean> {
  const result = applyRegistryPolicy({
    path,
    ecosystem,
    dependencies: names.map((n) => dep(n, ecosystem)),
    files: new Map(Object.entries(files)),
  });
  return Object.fromEntries(result.map((d) => [d.name, d.supported]));
}

describe("registryConfigPaths", () => {
  it("lists ancestor config candidates from root to the manifest directory", () => {
    const npmPaths = registryConfigPaths("apps/web/package.json", "NPM");
    expect(npmPaths).toContain(".npmrc");
    expect(npmPaths).toContain("apps/.npmrc");
    expect(npmPaths).toContain("apps/web/.npmrc");
    expect(npmPaths.indexOf(".npmrc")).toBeLessThan(npmPaths.indexOf("apps/web/.npmrc"));

    const pyPaths = registryConfigPaths("services/api/pyproject.toml", "PYPI");
    expect(pyPaths).toContain("pip.conf");
    expect(pyPaths).toContain("services/api/uv.toml");
  });
});

describe("applyRegistryPolicy: publicRegistry URL validation", () => {
  it.each([
    ["non-HTTPS protocol", "http://registry.npmjs.org"],
    ["custom port", "https://registry.npmjs.org:8443"],
    ["username in URL", "https://user@registry.npmjs.org"],
    ["username and password in URL", "https://user:pass@registry.npmjs.org"],
    ["query string", "https://registry.npmjs.org?token=1"],
    ["hash fragment", "https://registry.npmjs.org#section"],
    ["non-root path", "https://registry.npmjs.org/custom"],
    ["not a URL", ":::invalid:::"],
  ])("rejects npm registry URL with %s", (_label, url) => {
    expect(check("NPM", { ".npmrc": `registry=${url}\n` }, ["react"])).toEqual({ react: false });
  });

  it.each([
    ["non-HTTPS protocol", "http://pypi.org/simple"],
    ["custom port", "https://pypi.org:8443/simple"],
    ["credentials", "https://__token__:pypi-xxx@pypi.org/simple"],
    ["query string", "https://pypi.org/simple?prefer=binary"],
    ["hash fragment", "https://pypi.org/simple#top"],
    ["missing /simple path", "https://pypi.org/"],
    ["wrong path /pypi", "https://pypi.org/pypi"],
    ["extra path segment", "https://pypi.org/simple/extra"],
  ])("rejects PyPI index URL with %s", (_label, url) => {
    expect(check("PYPI", { "uv.toml": `index-url = "${url}"\n` }, ["requests"])).toEqual({ requests: false });
  });

  it("accepts official npm/yarn and PyPI simple URLs with optional trailing slashes and quotes", () => {
    expect(check("NPM", { ".npmrc": 'registry = "https://registry.npmjs.org///"\n' }, ["react"])).toEqual({ react: true });
    expect(check("NPM", { ".yarnrc": 'registry "https://registry.yarnpkg.com/"\n' }, ["react"])).toEqual({ react: true });
    expect(check("PYPI", { "uv.toml": 'index-url = "https://pypi.python.org/simple/"\n' }, ["requests"])).toEqual({
      requests: true,
    });
  });
});

describe("applyRegistryPolicy: fail-closed and NPM scope handling", () => {
  it("fails closed on null file text, malformed YAML/TOML, non-record root, or YAML alias bombs", () => {
    expect(check("NPM", { ".npmrc": null }, ["react"])).toEqual({ react: false });
    expect(check("NPM", { ".yarnrc.yml": ": : : invalid yaml [\n" }, ["react"])).toEqual({ react: false });
    expect(check("NPM", { ".yarnrc.yml": "- just\n- a\n- list\n" }, ["react"])).toEqual({ react: false });
    expect(check("NPM", { "bunfig.toml": "[install\nbroken" }, ["react"])).toEqual({ react: false });
    expect(check("PYPI", { "uv.toml": "broken = [" }, ["requests"])).toEqual({ requests: false });

    // YAML alias bomb (> 50 aliases triggers maxAliasCount error)
    const aliases = Array.from({ length: 60 }, (_, i) => `k${i}: *a`).join("\n");
    const bomb = `a: &a\n  x: 1\n${aliases}\n`;
    expect(check("NPM", { ".yarnrc.yml": bomb }, ["react"])).toEqual({ react: false });
  });

  it("fails closed when npmScopes / scopes / registries is not a record", () => {
    expect(check("NPM", { ".yarnrc.yml": "npmScopes:\n  - not-a-map\n" }, ["react"])).toEqual({ react: false });
    expect(check("NPM", { "bunfig.toml": '[install]\nscopes = "not-a-table"\n' }, ["react"])).toEqual({ react: false });
    expect(check("NPM", { "pnpm-workspace.yaml": "registries: 123\n" }, ["react"])).toEqual({ react: false });
  });

  it("lets an auth-only scope inherit the default registry", () => {
    const authOnlyScope = "npmScopes:\n  scope:\n    npmAlwaysAuth: true\n    npmAuthToken: secret\n";
    expect(check("NPM", { ".yarnrc.yml": `npmRegistryServer: https://registry.npmjs.org\n${authOnlyScope}` })).toEqual({
      "@scope/pkg": true,
      react: true,
    });
    expect(check("NPM", { ".yarnrc.yml": `npmRegistryServer: https://private.example.com\n${authOnlyScope}` })).toEqual({
      "@scope/pkg": false,
      react: false,
    });
  });

  it("handles quoted '@scope:registry' keys in pnpm-workspace.yaml", () => {
    const yaml = '"@scope:registry": "https://private.example.com/"\n';
    expect(check("NPM", { "pnpm-workspace.yaml": yaml })).toEqual({
      "@scope/pkg": false,
      react: true,
    });
  });
});

describe("applyRegistryPolicy: Python pip.conf, uv and Poetry rules", () => {
  it("applies pip.conf settings in [global], [install] and [download] but ignores other sections", () => {
    expect(
      check("PYPI", { "pip.conf": "[freeze]\nindex-url = https://private.example.com/simple\n" }, ["requests"]),
    ).toEqual({ requests: true });

    for (const section of ["global", "install", "download"]) {
      expect(
        check("PYPI", { "pip.conf": `[${section}]\nindex-url = https://private.example.com/simple\n` }, ["requests"]),
      ).toEqual({ requests: false });
    }

    expect(
      check("PYPI", { "pip.conf": "[install]\nfind-links = https://private.example.com/wheels\n" }, ["requests"]),
    ).toEqual({ requests: false });
  });

  it("distinguishes uv explicit = true vs false on custom [[index]] entries", () => {
    const explicitOnly = `
[[index]]
name = "private"
url = "https://private.example.com/simple"
explicit = true

[sources]
internal-pkg = { index = "private" }
`;
    expect(check("PYPI", { "uv.toml": explicitOnly }, ["requests", "internal-pkg"])).toEqual({
      requests: true,
      "internal-pkg": false,
    });

    const implicitIndex = `
[[index]]
name = "private"
url = "https://private.example.com/simple"
explicit = false
`;
    expect(check("PYPI", { "uv.toml": implicitIndex }, ["requests", "internal-pkg"])).toEqual({
      requests: false,
      "internal-pkg": false,
    });
  });

  it("distinguishes Poetry source priority = 'explicit' vs 'primary' / 'supplemental'", () => {
    const explicitPoetry = `
[[tool.poetry.source]]
name = "private"
url = "https://private.example.com/simple"
priority = "explicit"
`;
    expect(check("PYPI", { "pyproject.toml": explicitPoetry }, ["requests"])).toEqual({ requests: true });

    for (const priority of ["primary", "supplemental"]) {
      const nonExplicit = `
[[tool.poetry.source]]
name = "private"
url = "https://private.example.com/simple"
priority = "${priority}"
`;
      expect(check("PYPI", { "pyproject.toml": nonExplicit }, ["requests"])).toEqual({ requests: false });
    }
  });

  it("does not allow a public pip.conf or [tool.uv.pip] section to clear a private pyproject.toml / uv.toml default index", () => {
    expect(
      check(
        "PYPI",
        {
          "pyproject.toml": '[tool.uv]\nindex-url = "https://pypi.internal.example/simple"\n',
          "pip.conf": "[global]\nindex-url = https://pypi.org/simple\n",
        },
        ["internal-pkg"],
      ),
    ).toEqual({ "internal-pkg": false });

    expect(
      check(
        "PYPI",
        {
          "pyproject.toml":
            '[tool.uv]\ndefault-index = "https://pypi.internal.example/simple"\n[tool.uv.pip]\nindex-url = "https://pypi.org/simple"\n',
        },
        ["internal-pkg"],
      ),
    ).toEqual({ "internal-pkg": false });
  });
});
