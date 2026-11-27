import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateFile,
  evaluateRepoMigrationsDir,
  evaluateStagedMigrationEntries,
  isLineIgnored,
  parseGitNameStatus,
  parseIgnoreDirective,
} from "../guardrails/rules.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function evalRel(relPath: string, content: string) {
  return evaluateFile({ repoRoot: REPO_ROOT, relPath, content });
}

describe("guardrail file rules", () => {
  it("enforces deps/pinned-versions across root, apps, and packages manifests", () => {
    const caretViolations = evalRel(
      "apps/web/package.json",
      JSON.stringify(
        {
          name: "@repopulse/web",
          dependencies: { react: "^19.3.1", zod: "catalog:" },
          devDependencies: { vitest: "~5.1.2" },
        },
        null,
        2,
      ),
    );
    expect(caretViolations.map((v) => v.ruleId)).toEqual(["deps/pinned-versions", "deps/pinned-versions"]);

    const rootOptionalPeer = evalRel(
      "package.json",
      JSON.stringify(
        {
          name: "repopulse",
          optionalDependencies: { fsevents: "^2.3.3" },
          peerDependencies: { typescript: "~7.0.2" },
        },
        null,
        2,
      ),
    );
    expect(rootOptionalPeer.map((v) => v.ruleId)).toEqual(["deps/pinned-versions", "deps/pinned-versions"]);

    const npmAliasRange = evalRel(
      "packages/deps/package.json",
      JSON.stringify(
        {
          dependencies: {
            alias: "npm:semver@^7.8.6",
          },
        },
        null,
        2,
      ),
    );
    expect(npmAliasRange.map((v) => v.ruleId)).toEqual(["deps/pinned-versions"]);

    const cleanManifest = evalRel(
      "packages/deps/package.json",
      JSON.stringify(
        {
          dependencies: {
            "@repopulse/tsconfig": "workspace:*",
            semver: "catalog:",
            yaml: "2.9.1",
            alias: "npm:smol-toml@1.9.1",
          },
        },
        null,
        2,
      ),
    );
    expect(cleanManifest).toEqual([]);
  });

  it("enforces security/no-raw-sql-unsafe and supports guardrail-ignore", () => {
    const rawViolations = evalRel(
      "apps/web/src/server/bad-query.ts",
      'await prisma.$queryRawUnsafe("SELECT 1");\nawait prisma.$executeRawUnsafe("DELETE FROM t");\n',
    );
    expect(rawViolations.map((v) => v.ruleId)).toEqual(["security/no-raw-sql-unsafe", "security/no-raw-sql-unsafe"]);

    const suppressed = evalRel(
      "apps/web/src/server/ok-query.ts",
      '// guardrail-ignore: security/no-raw-sql-unsafe — static DDL migration check\nawait prisma.$queryRawUnsafe("SELECT 1");\n',
    );
    expect(suppressed).toEqual([]);

    expect(evalRel("apps/web/src/server/safe.test.ts", 'await prisma.$queryRawUnsafe("SELECT 1");\n')).toEqual([]);
    expect(
      evalRel("packages/db/src/generated/prisma/client.ts", 'await prisma.$queryRawUnsafe("SELECT 1");\n'),
    ).toEqual([]);
    expect(evalRel("apps/web/src/server/safe.ts", "await prisma.$queryRaw`SELECT 1`;\n")).toEqual([]);
  });

  it("enforces security/no-hardcoded-secrets outside test files and allows suppression", () => {
    const pemCases = [
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "-----BEGIN DSA PRIVATE KEY-----",
    ];
    for (const header of pemCases) {
      expect(evalRel("apps/worker/src/auth/key.ts", `const key = "${header}";\n`).map((v) => v.ruleId)).toContain(
        "security/no-hardcoded-secrets",
      );
    }

    expect(
      evalRel(
        "apps/worker/src/auth/key.ts",
        '// guardrail-ignore: security/no-hardcoded-secrets -- format parser header check\nconst header = "-----BEGIN RSA PRIVATE KEY-----";\n',
      ),
    ).toEqual([]);

    expect(
      evalRel("packages/github/src/app.test.ts", 'const pem = "-----BEGIN RSA PRIVATE KEY-----\\nsecret";\n'),
    ).toEqual([]);

    expect(
      evalRel(
        "apps/web/src/components/admin/github-app-settings.tsx",
        'placeholder={"-----BEGIN RSA PRIVATE KEY-----\\n…\\n-----END RSA PRIVATE KEY-----"}\n',
      ),
    ).toEqual([]);
  });

  it("enforces migrations/folder-naming for directories and migration files", () => {
    expect(
      evalRel("packages/db/prisma/migrations/bad-folder/migration.sql", "CREATE TABLE test (id int);\n").map(
        (v) => v.ruleId,
      ),
    ).toContain("migrations/folder-naming");

    expect(
      evalRel("packages/db/prisma/migrations/20261127180000_valid_name/migration.sql", "CREATE TABLE test (id int);\n"),
    ).toEqual([]);

    expect(evalRel("packages/db/prisma/migrations/migration_lock.toml", 'provider = "postgresql"\n')).toEqual([]);

    const tempRoot = mkdtempSync(join(tmpdir(), "repopulse-mig-test-"));
    try {
      const migBase = join(tempRoot, "packages/db/prisma/migrations");
      mkdirSync(join(migBase, "20261127180000_valid_init"), { recursive: true });
      mkdirSync(join(migBase, "invalid_folder"), { recursive: true });
      writeFileSync(join(migBase, "migration_lock.toml"), 'provider = "postgresql"\n', "utf8");

      const dirViolations = evaluateRepoMigrationsDir(tempRoot);
      expect(dirViolations).toHaveLength(1);
      expect(dirViolations[0]?.ruleId).toBe("migrations/folder-naming");
      expect(dirViolations[0]?.filePath).toBe("packages/db/prisma/migrations/invalid_folder");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("enforces migrations/no-shipped-migration-edits on staged M/D/R entries and allows A", () => {
    const rawStatus = [
      "A\tpackages/db/prisma/migrations/20261127180000_brand_new/migration.sql",
      "M\tpackages/db/prisma/migrations/20261031000000_init/migration.sql",
      "D\tpackages/db/prisma/migrations/20261031120000_release_backfill/migration.sql",
      "R100\tpackages/db/prisma/migrations/20261101090000_tag_tracking/migration.sql\tpackages/db/prisma/migrations/20261101090000_tag_renamed/migration.sql",
      "M\tpackages/db/prisma/schema.prisma",
    ].join("\n");

    const entries = parseGitNameStatus(rawStatus);
    const violations = evaluateStagedMigrationEntries(entries);
    expect(violations).toHaveLength(3);
    expect(violations.every((v) => v.ruleId === "migrations/no-shipped-migration-edits")).toBe(true);
    expect(violations.map((v) => v.filePath)).toEqual([
      "packages/db/prisma/migrations/20261031000000_init/migration.sql",
      "packages/db/prisma/migrations/20261031120000_release_backfill/migration.sql",
      "packages/db/prisma/migrations/20261101090000_tag_tracking/migration.sql",
    ]);

    const cleanEntries = parseGitNameStatus(
      "A\tpackages/db/prisma/migrations/20261127180000_new_migration/migration.sql\nM\tapps/web/src/app/page.tsx\n",
    );
    expect(evaluateStagedMigrationEntries(cleanEntries)).toEqual([]);
  });

  it("enforces arch/workspace-dep-isolation boundaries", () => {
    expect(
      evalRel(
        "packages/deps/package.json",
        JSON.stringify({
          dependencies: { "@repopulse/db": "workspace:*", "@octokit/rest": "21.0.0" },
        }),
      ).map((v) => v.ruleId),
    ).toEqual(["arch/workspace-dep-isolation", "arch/workspace-dep-isolation"]);

    expect(
      evalRel(
        "packages/notifications/package.json",
        JSON.stringify({ dependencies: { "@repopulse/db": "workspace:*" } }),
      ).map((v) => v.ruleId),
    ).toEqual(["arch/workspace-dep-isolation"]);

    expect(
      evalRel(
        "apps/worker/package.json",
        JSON.stringify({ dependencies: { "@repopulse/deps-worker": "workspace:*" } }),
      ).map((v) => v.ruleId),
    ).toEqual(["arch/workspace-dep-isolation"]);

    expect(
      evalRel(
        "apps/deps-worker/package.json",
        JSON.stringify({ devDependencies: { "@repopulse/worker": "workspace:*" } }),
      ).map((v) => v.ruleId),
    ).toEqual(["arch/workspace-dep-isolation"]);

    expect(
      evalRel("packages/deps/package.json", JSON.stringify({ dependencies: { semver: "catalog:", zod: "catalog:" } })),
    ).toEqual([]);
  });

  it("parses guardrail-ignore directives with em-dash or double-hyphen and >=5 non-ws chars", () => {
    expect(parseIgnoreDirective("// guardrail-ignore: security/no-raw-sql-unsafe — ok")).toBeNull();
    expect(parseIgnoreDirective("// guardrail-ignore: security/no-raw-sql-unsafe —     ")).toBeNull();
    expect(parseIgnoreDirective("// guardrail-ignore: security/no-raw-sql-unsafe — static DDL")).toEqual({
      ruleId: "security/no-raw-sql-unsafe",
      reason: "static DDL",
    });
    expect(parseIgnoreDirective("// guardrail-ignore: security/no-hardcoded-secrets -- fixture regex")).toEqual({
      ruleId: "security/no-hardcoded-secrets",
      reason: "fixture regex",
    });

    const lines = [
      "// guardrail-ignore: security/no-raw-sql-unsafe — intentional static query",
      'await prisma.$queryRawUnsafe("SELECT 1");',
    ];
    expect(isLineIgnored(lines, 1, "security/no-raw-sql-unsafe")).toBe(true);
    expect(isLineIgnored(lines, 1, "security/no-hardcoded-secrets")).toBe(false);
  });
});
