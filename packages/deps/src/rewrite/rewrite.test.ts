import { describe, expect, it } from "vitest";
import { ManifestRewriteError } from "./common.js";
import { rewritePackageJson } from "./package-json.js";
import { rewritePyproject } from "./pyproject.js";
import { normalizeSha256Hashes, rewriteRequirements } from "./requirements.js";

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestRewriteError);
    expect((error as ManifestRewriteError).code).toBe(code);
    return;
  }
  throw new Error("expected a ManifestRewriteError");
};

describe("rewritePackageJson", () => {
  const text = `{\r\n  "name": "x",\r\n  "dependencies": {\r\n    "react": "^18.2.0",\r\n    "@scope/a": "~1.0.0"\r\n  },\r\n  "devDependencies": { "react": "^18.0.0" }\r\n}\r\n`;

  it("edits only the planned values, keeping CRLF and the trailing newline", () => {
    const next = rewritePackageJson(text, [
      { name: "react", kind: "PROD", group: "", from: "^18.2.0", to: "^18.3.1" },
      { name: "@scope/a", kind: "PROD", group: "", from: "~1.0.0", to: "~1.0.5" },
    ]);
    expect(next).toBe(text.replace('"^18.2.0"', '"^18.3.1"').replace('"~1.0.0"', '"~1.0.5"'));
    expect(next.endsWith("}\r\n")).toBe(true);
    expect(next).toContain('"devDependencies": { "react": "^18.0.0" }');
  });

  it("rejects missing, stale and unsafe edits", () => {
    expectCode(() => rewritePackageJson(text, [{ name: "vue", kind: "PROD", group: "", from: "1", to: "2" }]), "NOT_FOUND");
    expectCode(() => rewritePackageJson(text, [{ name: "react", kind: "PROD", group: "", from: "^18.0.0", to: "^19" }]), "STALE");
    expectCode(() => rewritePackageJson(text, [{ name: "react", kind: "PROD", group: "", from: "^18.2.0", to: '1", "x": "y' }]), "INVALID_VALUE");
  });

  it("refuses values with escapes", () => {
    const escaped = `{"dependencies":{"a":"\\u005e1.0.0"}}`;
    expectCode(() => rewritePackageJson(escaped, [{ name: "a", kind: "PROD", group: "", from: "^1.0.0", to: "^1.1.0" }]), "NOT_REWRITABLE");
  });
});

describe("rewriteRequirements", () => {
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const C = "c".repeat(64);
  const D = "D".repeat(64);

  it("replaces pins and the whole hash set, keeping the continuation layout", () => {
    const text = [
      "# header",
      "django==4.2.7 \\",
      `    --hash=sha256:${A} \\`,
      `    --hash=sha256:${B}`,
      "    # via -r requirements.in",
      `requests==2.31.0 ; python_version >= "3.8" \\`,
      `    --hash=sha256:${A}`,
      "",
    ].join("\r\n");
    const next = rewriteRequirements(text, [
      { name: "Django", kind: "PROD", group: "", from: "==4.2.7", to: "==4.2.16", hashes: [D, `sha256:${C}`, C] },
      { name: "requests", kind: "PROD", group: "", from: "==2.31.0", to: "==2.32.3", hashes: [B] },
    ]);
    expect(next).toBe(
      [
        "# header",
        "django==4.2.16 \\",
        `    --hash=sha256:${C} \\`,
        `    --hash=sha256:${D.toLowerCase()}`,
        "    # via -r requirements.in",
        `requests==2.32.3 ; python_version >= "3.8" \\`,
        `    --hash=sha256:${B}`,
        "",
      ].join("\r\n"),
    );
  });

  it("keeps inline hash layout", () => {
    const next = rewriteRequirements(`idna==3.4 --hash sha256:${A}\n`, [
      { name: "idna", kind: "PROD", group: "", from: "==3.4", to: "==3.10", hashes: [B, C] },
    ]);
    expect(next).toBe(`idna==3.10 --hash sha256:${B} --hash sha256:${C}\n`);
  });

  it("edits unhashed specifiers and leaves the rest untouched", () => {
    const text = "flask>=2.0,<3  # web\nclick==8.0\n";
    expect(rewriteRequirements(text, [{ name: "flask", kind: "PROD", group: "", from: ">=2.0,<3", to: ">=2.3,<3" }])).toBe(
      "flask>=2.3,<3  # web\nclick==8.0\n",
    );
  });

  it("requires hashes for hashed lines and rejects stale / missing / unpinned", () => {
    const text = `a==1.0 --hash=sha256:${A}\nb\n`;
    expectCode(() => rewriteRequirements(text, [{ name: "a", kind: "PROD", group: "", from: "==1.0", to: "==1.1" }]), "HASHES_REQUIRED");
    expectCode(() => rewriteRequirements(text, [{ name: "a", kind: "PROD", group: "", from: "==0.9", to: "==1.1", hashes: [B] }]), "STALE");
    expectCode(() => rewriteRequirements(text, [{ name: "zzz", kind: "PROD", group: "", from: "", to: "==1" }]), "NOT_FOUND");
    expectCode(() => rewriteRequirements(text, [{ name: "b", kind: "PROD", group: "", from: "", to: "==1" }]), "NOT_REWRITABLE");
    expectCode(() => rewriteRequirements(text, [{ name: "a", kind: "PROD", group: "", from: "==1.0", to: "==1.1 # x", hashes: [B] }]), "INVALID_VALUE");
    expectCode(() => rewriteRequirements(text, [{ name: "a", kind: "PROD", group: "", from: "==1.0", to: "==1.1", hashes: ["nothex"] }]), "INVALID_VALUE");
  });

  it("normalizes hashes", () => {
    expect(normalizeSha256Hashes([`sha256:${B}`, A.toUpperCase(), A])).toEqual([`sha256:${A}`, `sha256:${B}`]);
  });
});

describe("rewritePyproject", () => {
  const text = `[project]
name = "demo"
dependencies = [
  "httpx>=0.27,<1",  # keep
  'rich[jupyter]==13.7.1 ; python_version >= "3.10"',
]

[dependency-groups]
dev = ["pytest>=8"]

[tool.poetry.dependencies]
python = "^3.11"
Django = "^5.0"
requests = { version = "^2.31", extras = ["socks"] }
`;

  it("edits strings in arrays, groups and Poetry tables", () => {
    const next = rewritePyproject(text, [
      { name: "httpx", kind: "PROD", group: "", from: ">=0.27,<1", to: ">=0.28,<1" },
      { name: "rich", kind: "PROD", group: "", from: "==13.7.1", to: "==13.9.4" },
      { name: "pytest", kind: "GROUP", group: "dev", from: ">=8", to: ">=8.3" },
      { name: "django", kind: "PROD", group: "", from: "^5.0", to: "^5.1" },
      { name: "requests", kind: "PROD", group: "", from: "^2.31", to: "^2.32" },
    ]);
    expect(next).toBe(
      text
        .replace(">=0.27,<1", ">=0.28,<1")
        .replace("==13.7.1", "==13.9.4")
        .replace('"pytest>=8"', '"pytest>=8.3"')
        .replace('"^5.0"', '"^5.1"')
        .replace('"^2.31"', '"^2.32"'),
    );
  });

  it("rejects wrong groups, stale specs and quotes", () => {
    expectCode(() => rewritePyproject(text, [{ name: "pytest", kind: "GROUP", group: "test", from: ">=8", to: ">=9" }]), "NOT_FOUND");
    expectCode(() => rewritePyproject(text, [{ name: "httpx", kind: "PROD", group: "", from: ">=0.1", to: ">=0.28" }]), "STALE");
    expectCode(() => rewritePyproject(text, [{ name: "httpx", kind: "PROD", group: "", from: ">=0.27,<1", to: '>=1"' }]), "INVALID_VALUE");
  });
});
