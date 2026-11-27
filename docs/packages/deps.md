# `@repopulse/deps` (`packages/deps`)

> **Summary:** pure TypeScript logic for the Dependencies module: manifest detection and parsing, lockfile readers, npm / PEP 440 / Poetry version engines, npm / PyPI registry clients, update planning, span-preserving manifest rewrites, PR text builders, limits, and the sandbox HTTP contract. Used by `apps/deps-worker`, `apps/deps-sandbox` (contract + limits), and `apps/web` (limits, schemas, planning helpers).
>
> **Related Docs:** [../guides/dependencies.md](../guides/dependencies.md) · [../apps/deps-worker.md](../apps/deps-worker.md) · [../apps/deps-sandbox.md](../apps/deps-sandbox.md) · [../CONTRACTS.md](../CONTRACTS.md)

## Rules

- **MUST NOT** depend on `@repopulse/db` or Octokit. Keep inputs structural and inject `fetch` / caches.
- **MUST NOT** import `node:*` modules from the browser-safe subpaths `@repopulse/deps/limits` and `@repopulse/deps/sandbox-contract` (imported by `apps/web`).
- **MUST NOT** fetch user-supplied registry URLs: registry clients use fixed public hosts (`NPM_REGISTRY_URL`, `PYPI_SIMPLE_URL`, `PYPI_JSON_URL`).
- **MUST** keep manifest rewrites as JS string-offset span edits followed by a structural re-parse check (`ManifestRewriteError` on mismatch).
- **MUST** use `.js` extensions on relative ESM imports and run `pnpm --filter "./packages/*" build` after edits.

Dependencies: `semver`, `smol-toml`, `yaml`, `zod`.

## Public Exports (`packages/deps/src/index.ts`)

| Export / Subpath | What |
| --- | --- |
| `@repopulse/deps/limits` (also root) | Browser-safe caps & defaults: `MAX_DEPENDENCY_PROJECTS_PER_USER` (50), `MAX_PROJECTS_PER_ADD` (20), `MAX_MANIFESTS_PER_PROJECT` (25), `MAX_DEPENDENCIES_PER_PROJECT` (1,000), `MAX_MANIFEST_BYTES` (1 MiB), `MAX_LOCKFILE_BYTES` (20 MiB), `MAX_SANDBOX_BODY_BYTES`, `MAX_SANDBOX_STDERR_TAIL_BYTES`, `MAX_IGNORE_RULES` (50), `SCAN_COOLDOWN_MS` (5 min), `REGISTRY_CACHE_TTL_MS` (1 h), `REGISTRY_CONCURRENCY` (8), `DIGEST_MAX_ITEMS`, `SCAN_INTERVAL_HOURS`, `MIN_RELEASE_AGE_DAYS_MAX` (30), `MAX_OPEN_PRS_MAX` (20), `DEPS_BRANCH_PREFIX`, `DEPS_WORKER_HEARTBEAT_*`, `DEPENDENCY_PROJECT_DEFAULTS` |
| `@repopulse/deps/sandbox-contract` | Browser-safe `deps-worker` ↔ `deps-sandbox` Zod schemas: `lockRequestSchema`, `lockResponseSchema`, `sandboxHealthSchema`, `SANDBOX_PACKAGE_MANAGERS`, `LOCK_ERROR_CODES` |
| `detectManifests(tree, opts)`, `resolveManifestGroups`, `detectManifestsWithReader`, `manifestFormatOf`, `packageManagerFromField`, `SKIPPED_DIRECTORIES`, `registry-config.ts` | Manifest & workspace detection, package manager precedence, ancestor registry config checks |
| `parsePackageJson`, `parseRequirements` / `parseRequirementsTree` / `readRequirementsPins`, `parsePyproject`, `parsePep508`, `manifests/errors.ts` | Manifest parsers tracking JS string-offset spans per dependency |
| `readLockfile`, `read{PackageLock,PnpmLock,BunLock,YarnLock,UvLock,PoetryLock}`, `prepareLockfile`, `PreparedLockfile` | Lockfile readers → resolved versions + format version (single-parse `prepareLockfile` shared across workspace manifests); oversized/broken files return an empty map + warning |
| `compareVersions`, `satisfiesRange`, `maxSatisfying`, `rangeLowerBound`, `bumpRange`, `npm*`, `pep440*`, `parsePep440`, `BumpResult` | Version & range math per `RangeSyntax` (`npm`, `pep440`, `poetry`) |
| `fetchRegistryPackage`, `fetchNpmPackage`, `fetchPypiPackage`, `RegistryCache`, `registryCacheKey`, `createMemoryRegistryCache`, `RegistryUnavailableError`, `REGISTRY_CACHE_RETENTION_MS` (7 days) | Registry clients (fixed hosts, ETag revalidation, byte caps, timeouts, single-flight dedup) |
| `selectTarget`, `applyPolicy`, `classifyUpdate`, `groupUpdates`, `groupCapability`, `manifestCheckOnlyReason`, `manifestNeedsLockfile`, `ignoreRuleSchema`, `ignoreRulesSchema`, `isValidGroupKey`, `slugifyGroupName` | Pure policy planner and grouping engine |
| `rewritePackageJson`, `rewriteRequirements`, `rewritePyproject`, `ManifestRewriteError` | Span edits with structural re-parse validation |
| `depsBranchName`, `buildCommitMessage`, `buildPrTitle`, `buildPrBody`, `buildTargets`, `formatTarget`, `parseTarget`, `depsPrMarker` | PR branch, commit, and Markdown body builders |
| `normalizePypiName`, `types.ts` | PEP 503 name normalization and structural types |

## Planning (`plan.ts`)

`selectTarget(candidates, dependency, policy, now)`, evaluated in order:

1. Unsupported spec → `UNSUPPORTED_SOURCE`. Drop deprecated, yanked, pre-release (unless `includePrereleases` and current version is a pre-release of the same `major.minor`), and `requires-python`-incompatible versions.
2. Ignore rule without `versions` → `IGNORED`; with `versions`, removes matching candidates. Patterns allow `*` only at start and/or end, case-insensitive, PyPI names PEP 503-normalized.
3. Current version = lockfile's resolved version, else lower bound of `declared`. Nothing newer (or no current version) → `UP_TO_DATE` (row deleted).
4. Only versions within `maxUpdateLevel` (major, or minor on `0.x`, counts as major) are eligible; none → `ABOVE_LEVEL` (`latestVersion` still shows the newest).
5. Younger than `minReleaseAgeDays` → newest old-enough version above current, else `TOO_NEW` (missing publish date counts as old enough).
6. `LOCKFILE_ONLY` and peer dependencies require the target inside `declared`; `BUMP` bumps the range while keeping its operator **and written precision** (`>=1.2` stays `>=1.2` for `1.2.5`, leaving nothing to commit without a lockfile). If the range admits nothing → `BLOCKED_BY_RANGE`.
7. A target equal to a `DISMISSED` version stays `DISMISSED`; a newer one becomes `OUTDATED` again.

`targetVersion` is set only for `OUTDATED` and `DISMISSED` rows. `classifyUpdate` → `level` uses `classifySemver` thresholds.

`groupUpdates(outdated, groupMode, maxOpenPrs)`:
- `SINGLE` → `all`
- `SEPARATE_MAJORS` → `all` + `major-<slug>` per major dependency
- `PER_DEPENDENCY` → `<eco>-<slug>` (every manifest using that name moves together)

Majors sort last; only the first `maxOpenPrs` groups get a slot. `groupCapability` disables "Create PR" for check-only managers (`Yarn`, `bun.lockb`, `pip-tools`) and for lockfile groups when the sandbox is unconfigured (web also disables it while the `deps-worker` heartbeat shows no reachable sandbox).

## Supported Ecosystems & Detection

| Package manager | Manifest | Current versions from | Update PR |
| --- | --- | --- | --- |
| npm / pnpm / Bun | `package.json` (+ workspaces, `pnpm-workspace.yaml`) | `package-lock.json` v2/v3, `npm-shrinkwrap.json`, `pnpm-lock.yaml` v9, `bun.lock` | yes, lockfile from sandbox |
| Bun (binary) | `package.json` | declared range (`bun.lockb` unreadable) | check only |
| Yarn | `package.json` | `yarn.lock` (classic, Berry) | check only |
| none (npm / PyPI) | `package.json` / `pyproject.toml` without lockfile | declared range | yes, manifest only |
| pip | `requirements*.txt`, `requirements/*.txt`, `constraints*.txt` (`-r` / `-c` followed, depth 5) | `==` pins | yes, text edit + hashes |
| uv / Poetry | `pyproject.toml` (PEP 621, PEP 735, `[tool.poetry]`) | `uv.lock` / `poetry.lock` | yes, lockfile from sandbox |
| pip-tools | `requirements.in` + compiled `.txt` | compiled pins | check only |

- **npm-family detection order:** `packageManager` field, then root lockfile (`pnpm-lock.yaml` > `bun.lock` > `bun.lockb` > `yarn.lock` > `npm-shrinkwrap.json` > `package-lock.json`).
- **Skipped directories:** `node_modules`, `.venv`, `venv`, `vendor`, `dist`, `build`, `.git`, `fixtures`, `__fixtures__`, `testdata`, `examples`. Max 25 manifests (shallowest first) unless `manifestPaths` is set.
- **Unsupported specs:** git, file, link, workspace, `catalog:`, `npm:` aliases, URLs, `*` / dist-tags, npm/pnpm `overrides`, Yarn `resolutions` become `UNSUPPORTED_SOURCE` (never dropped). `--index-url` marks the requirements file `UNSUPPORTED_SOURCE`; `--extra-index-url` warns. Custom registries in ancestor config files fail closed as `UNSUPPORTED_SOURCE`.
- **Registries:** npm abbreviated packument (plus full `time` document only when `minReleaseAgeDays` needs it), PyPI Simple JSON (PEP 691 / 700: upload time, yanked, `requires-python`, sha256) fetched concurrently with `/pypi/<name>/json` (`project_urls`). Cached in Redis `deps:reg:<namespace>:<name>` (fresh 1 h, `If-None-Match` revalidation, 7-day retention).
