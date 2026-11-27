import { describe, expect, it } from "vitest";
import { applyReplacements, assertSafeSpec, ManifestRewriteError } from "./common.js";
import { rewritePackageJson } from "./package-json.js";
import { rewritePyproject } from "./pyproject.js";
import { normalizeSha256Hashes, rewriteRequirements } from "./requirements.js";

const captureRewriteError = (fn: () => unknown): ManifestRewriteError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestRewriteError);
    return error as ManifestRewriteError;
  }
  throw new Error("expected a ManifestRewriteError");
};

describe("common rewrite helpers", () => {
  it("applyReplacements rejects overlapping spans with VERIFY_FAILED", () => {
    expect(
      captureRewriteError(() =>
        applyReplacements(
          "abcdef",
          [
            { span: { start: 1, end: 4 }, text: "BCD" },
            { span: { start: 3, end: 5 }, text: "DE" },
          ],
          "file.txt",
        ),
      ).code,
    ).toBe("VERIFY_FAILED");
  });

  it("assertSafeSpec rejects empty/whitespace and control characters", () => {
    expect(captureRewriteError(() => assertSafeSpec("   ", "package.json", /["\\]/)).code).toBe("INVALID_VALUE");
    expect(captureRewriteError(() => assertSafeSpec("1.0.0\u0000", "package.json", /["\\]/)).code).toBe(
      "INVALID_VALUE",
    );
    expect(captureRewriteError(() => assertSafeSpec("1.0.0\u001f", "package.json", /["\\]/)).code).toBe(
      "INVALID_VALUE",
    );
    expect(captureRewriteError(() => assertSafeSpec("1.0.0\u007f", "package.json", /["\\]/)).code).toBe(
      "INVALID_VALUE",
    );
  });
});

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
    expect(
      captureRewriteError(() =>
        rewritePackageJson(text, [{ name: "vue", kind: "PROD", group: "", from: "1", to: "2" }]),
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      captureRewriteError(() =>
        rewritePackageJson(text, [{ name: "react", kind: "PROD", group: "", from: "^18.0.0", to: "^19" }]),
      ).code,
    ).toBe("STALE");
    expect(
      captureRewriteError(() =>
        rewritePackageJson(text, [{ name: "react", kind: "PROD", group: "", from: "^18.2.0", to: '1", "x": "y' }]),
      ).code,
    ).toBe("INVALID_VALUE");
  });

  it("refuses values with escapes", () => {
    const escaped = `{"dependencies":{"a":"\\u005e1.0.0"}}`;
    expect(
      captureRewriteError(() =>
        rewritePackageJson(escaped, [{ name: "a", kind: "PROD", group: "", from: "^1.0.0", to: "^1.1.0" }]),
      ).code,
    ).toBe("NOT_REWRITABLE");
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

  it("keeps inline hash layout and single-hash continuation layout when expanding to multiple hashes", () => {
    const next = rewriteRequirements(`idna==3.4 --hash sha256:${A}\n`, [
      { name: "idna", kind: "PROD", group: "", from: "==3.4", to: "==3.10", hashes: [B, C] },
    ]);
    expect(next).toBe(`idna==3.10 --hash sha256:${B} --hash sha256:${C}\n`);

    const singleContinued = `idna==3.4 \\\n    --hash=sha256:${A}\n`;
    const expanded = rewriteRequirements(singleContinued, [
      { name: "idna", kind: "PROD", group: "", from: "==3.4", to: "==3.10", hashes: [B, C] },
    ]);
    expect(expanded).toBe(`idna==3.10 \\\n    --hash=sha256:${B} \\\n    --hash=sha256:${C}\n`);
  });

  it("edits unhashed specifiers and leaves the rest untouched", () => {
    const text = "flask>=2.0,<3  # web\nclick==8.0\n";
    expect(
      rewriteRequirements(text, [{ name: "flask", kind: "PROD", group: "", from: ">=2.0,<3", to: ">=2.3,<3" }]),
    ).toBe("flask>=2.3,<3  # web\nclick==8.0\n");
  });

  it("requires hashes for hashed lines and rejects stale / missing / unpinned", () => {
    const text = `a==1.0 --hash=sha256:${A}\nb\n`;
    expect(
      captureRewriteError(() =>
        rewriteRequirements(text, [{ name: "a", kind: "PROD", group: "", from: "==1.0", to: "==1.1" }]),
      ).code,
    ).toBe("HASHES_REQUIRED");
    expect(
      captureRewriteError(() =>
        rewriteRequirements(text, [{ name: "a", kind: "PROD", group: "", from: "==0.9", to: "==1.1", hashes: [B] }]),
      ).code,
    ).toBe("STALE");
    expect(
      captureRewriteError(() =>
        rewriteRequirements(text, [{ name: "zzz", kind: "PROD", group: "", from: "", to: "==1" }]),
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      captureRewriteError(() =>
        rewriteRequirements(text, [{ name: "b", kind: "PROD", group: "", from: "", to: "==1" }]),
      ).code,
    ).toBe("NOT_REWRITABLE");
    expect(
      captureRewriteError(() =>
        rewriteRequirements(text, [
          { name: "a", kind: "PROD", group: "", from: "==1.0", to: "==1.1 # x", hashes: [B] },
        ]),
      ).code,
    ).toBe("INVALID_VALUE");
    expect(
      captureRewriteError(() =>
        rewriteRequirements(text, [
          { name: "a", kind: "PROD", group: "", from: "==1.0", to: "==1.1", hashes: ["nothex"] },
        ]),
      ).code,
    ).toBe("INVALID_VALUE");
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
    expect(
      captureRewriteError(() =>
        rewritePyproject(text, [{ name: "pytest", kind: "GROUP", group: "test", from: ">=8", to: ">=9" }]),
      ).code,
    ).toBe("NOT_FOUND");
    expect(
      captureRewriteError(() =>
        rewritePyproject(text, [{ name: "httpx", kind: "PROD", group: "", from: ">=0.1", to: ">=0.28" }]),
      ).code,
    ).toBe("STALE");
    expect(
      captureRewriteError(() =>
        rewritePyproject(text, [{ name: "httpx", kind: "PROD", group: "", from: ">=0.27,<1", to: '>=1"' }]),
      ).code,
    ).toBe("INVALID_VALUE");
  });

  it("updates duplicate dependencies in the same group and rejects escaped strings with NOT_REWRITABLE", () => {
    const dupToml = `[project]\nname = "demo"\ndependencies = [\n  "urllib3>=1.26 ; python_version < '3.10'",\n  "urllib3>=1.26 ; python_version >= '3.10'",\n]\n`;
    const updated = rewritePyproject(dupToml, [
      { name: "urllib3", kind: "PROD", group: "", from: ">=1.26", to: ">=2.2" },
    ]);
    expect(updated).toBe(
      `[project]\nname = "demo"\ndependencies = [\n  "urllib3>=2.2 ; python_version < '3.10'",\n  "urllib3>=2.2 ; python_version >= '3.10'",\n]\n`,
    );

    const escapedToml = `[project]\nname = "demo"\ndependencies = ["httpx\\u003e=0.27"]\n`;
    expect(
      captureRewriteError(() =>
        rewritePyproject(escapedToml, [{ name: "httpx", kind: "PROD", group: "", from: ">=0.27", to: ">=0.28" }]),
      ).code,
    ).toBe("NOT_REWRITABLE");
  });
});
