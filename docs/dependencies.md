# Dependencies module (Slice 08)

> **Summary:** an independent module that checks the user's **own** repositories ("projects") for outdated direct
> npm / Bun / PyPI dependencies, notifies about them and, with the RepoPulse GitHub App, opens update pull requests
> with regenerated lockfiles. Pure logic lives in `@repopulse/deps`. Three services run it: `deps-worker` (BullMQ,
> secrets), `deps-sandbox` (runs package managers, no secrets) and `deps-egress` (allowlist proxy). The release
> `worker` gains nothing. The module is **off** until the super admin enables it in Admin → Dependencies.

## Files

| Concern | File |
| --- | --- |
| Pure logic: detection, parsers, lockfile readers, versions (npm semver, PEP 440, Poetry), registries, planning, rewrites, PR text, sandbox contract, limits | `packages/deps/src/**` (see [packages.md](./packages.md#repopulsedeps-packagesdeps)) |
| Worker entry, config, health (`:3002`), heartbeat | `apps/deps-worker/src/{index,config,health,heartbeat}.ts` |
| Processors | `apps/deps-worker/src/processors/deps-{scheduler,scan,update,notify}.processor.ts`, `notify-jobs.ts` |
| Read / write credentials (App installation tokens, OAuth fallback) | `apps/deps-worker/src/github-access.ts` |
| Shared scan / update analysis (read tree, parse, look up, plan) | `apps/deps-worker/src/analysis.ts` |
| Redis caches (registry, blobs, lockfile reads), sandbox client + lockfile validation | `apps/deps-worker/src/{registry-cache,sandbox-client}.ts` |
| Sandbox HTTP server, job runner, command lines, tool versions, image | `apps/deps-sandbox/src/{app,server,run-lock,commands,tools}.ts`, `apps/deps-sandbox/Dockerfile` |
| Egress allowlist | `deploy/deps-egress/squid.conf` (+ `README.md`: how to test it) |
| Queue names, payloads, options, jobIds | `packages/queue/src/deps.ts` |
| GitHub App, Git Data API, webhooks | `packages/github/src/{app,app-hook,git-tree,git-write}.ts` ([auth-and-access.md](./auth-and-access.md#github-app-dependencies)) |
| Dependency notifications | `packages/notifications/src/dependency-dispatcher.ts`, `formatters/dependencies.ts` ([notifications.md](./notifications.md#dependency-notifications)) |
| Web pages, actions, queries | `apps/web/src/app/(dashboard)/dependencies/**`, `server/actions/dependencies.ts`, `server/queries/dependencies.ts`, `server/deps-status.ts`, `lib/dependency-{settings,list-filters}.ts`, `components/dependencies/*` ([web-app.md](./web-app.md)) |
| Webhook route | `apps/web/src/app/api/github-app/webhook/route.ts`, `server/github-app-webhook.ts`, `server/deps-webhook-queue.ts` |

## Rules

- **MUST NOT** run anything from a repository (package managers, build backends, scripts) in `deps-worker` or
  `web`. They only parse with pure TypeScript and edit text. Everything that executes goes to `deps-sandbox`.
- **MUST NOT** give `deps-sandbox` a secret besides `DEPS_SANDBOX_TOKEN`: no database, Redis, GitHub token, volume or
  `env_file`. Children get an environment built from scratch (`buildSandboxEnv`).
- **MUST** keep the bot writing only what it planned: a commit contains only the group's manifests and lockfiles,
  every rewrite is re-parsed and compared with the plan, and sandbox lockfiles are validated by the worker
  (`validateLockfile` in `sandbox-client.ts`). Anything else aborts the job.
- **MUST NOT** overwrite a bot branch whose head is not the stored `headSha` (someone else pushed: `EDITED`, hands off).
- A persisted `DependencyBranchWriteIntent.commitSha` is also a known bot head: it is saved before the ref write
  and lets a retry recover after a push succeeded but PR creation or persistence failed. `previousHeadSha` retains
  the observed bot head if a subsequent replacement push fails. Any other head is hands off.
- **MUST** re-check, on **every** `deps-update` job: mode ≠ `NOTIFY`, the project owns PRs (`DependencyPrOwner`), the
  App is installed, and the owner's collaborator permission is `write`+. The web checks are a convenience.
- Automatic jobs also require the current mode to remain `AUTO_PR`. A group without a current PR slot cannot open
  a new PR; an existing open PR may still be maintained.
- **MUST** scope every web query to the signed-in user (projects are per user); admin pages and actions are super
  admin only. Every action that queues work returns `UNAVAILABLE` while the module is off.
- **MUST NOT** fetch a user-supplied URL: registry hosts are constants (`NPM_REGISTRY_URL`, `PYPI_SIMPLE_URL`,
  `PYPI_JSON_URL`), so the SSRF guard is not involved.
- **MUST NOT** put sandbox output (stderr) in a PR, an SSE message or a notification: the sanitized tail goes to the
  BullMQ job log only.
- **MUST NOT** import the release worker from `deps-worker` (or the reverse). `passesDependencyNotificationLevel` is
  a deliberate copy of `passesNotificationLevel`.
- Keep `@repopulse/deps` free of Prisma, Octokit and Node-only APIs in `limits` / `sandbox-contract` (the web imports
  them). Its inputs are structural.

## Services and trust boundaries

| Service | Holds | Network | Does |
| --- | --- | --- | --- |
| `deps-worker` | `DATABASE_URL`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY` (decrypts the App key and OAuth tokens), installation tokens (memory only), `DEPS_SANDBOX_TOKEN` | `default` + `deps_sandbox` | Scans, update PRs, notifications. Parses untrusted files as text only |
| `deps-sandbox` | `DEPS_SANDBOX_TOKEN` (removed from `process.env` at startup) | `deps_sandbox` only (`internal: true`) | `POST /v1/lock`: runs npm / pnpm / Bun / uv / Poetry in lockfile-only mode, returns the lockfile |
| `deps-egress` | nothing | `default` + `deps_sandbox` | Squid: `CONNECT` on 443 to `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`; denies everything else, private ranges included |
| `web` | as before | `default` | Pages, actions, `POST /api/github-app/webhook` (enqueue only) |

The App credentials are **not** env vars: they live encrypted on `InstanceSettings` and every process reads them per
use (`loadGitHubAppSettings`), so Admin changes apply without a restart.

## Lifecycle

- **Projects** (`DependencyProject`) are per user, unique on `(userId, githubRepoId)`, independent of subscriptions:
  `repositoryId` only powers the quick-add picker and the "Tracked" badge (`SetNull`).
- **Adding** (`addDependencyProjectsAction`, 1–20 sources, max 50 projects per user): reads the repository with the
  user's token, falling back to an App installation token for private repositories; a private repository needs the
  App installed **and** the user's `read` permission. A PR mode is offered only for a single repository and needs
  `write`. The first scan is queued at once (`trigger: "add"`). Unless "Notify about what is outdated now"
  (`notifyOnFirstScan`) was ticked, the first scan marks the current outdated rows as notified without sending.
- **PR ownership**: switching to `MANUAL_PR` / `AUTO_PR` claims `DependencyPrOwner` (primary key `githubRepoId`) in
  the settings transaction (`CONFLICT` naming the owner otherwise); `NOTIFY` or removing the project releases it.
  Losing access (App uninstalled, permission below `write`) during an update switches the project to `NOTIFY`,
  releases ownership and sends an `access_lost` notification.
- **Module off** (`InstanceSettings.depsEnabled = false`): the sidebar link is hidden, `/dependencies` explains it,
  actions that queue work answer `UNAVAILABLE`, and every processor returns `SKIPPED` / `DISABLED`. The webhook route
  answers 204.

## Queues (`DEPS_QUEUE_NAMES`, consumed only by `deps-worker`)

| Queue | Payload | jobId | Concurrency | Options |
| --- | --- | --- | --- | --- |
| `deps-scheduler` | `{}` | repeatable `deps-scheduler-cron` (`DEPS_SCAN_CRON`, default `17 * * * *`) | 1 | — |
| `deps-scan` | `{ projectId, trigger: "add" \| "schedule" \| "manual" \| "webhook", requestedByUserId? }` | `deps-scan-{projectId}` | `DEPS_SCAN_CONCURRENCY` (3), limiter 10/s | 3 attempts, exp. 60 s; priority manual / add 1, schedule / webhook 10; removeOnComplete/Fail |
| `deps-update` | `{ projectId, groupKey, trigger: "manual" \| "auto" }` | `deps-update-{projectId}-{groupKey}` | `DEPS_UPDATE_CONCURRENCY` (1), limiter 5/s | 2 attempts, exp. 120 s; priority manual 1 / auto 10; removeOnComplete/Fail |
| `deps-notify` | `{ ruleId, projectId, kind: "digest", scanId, updateIds }` or `{ …, kind: "pull_request", prId, event, dedupKey }` | `deps-notify-{ruleId}-{scanId \| prId-dedupKey}`; `scanId` hashes the rows' id + target version, so a newer target is never deduplicated away | 5 | 3 attempts, exp. 5 s; kept 7 days for dedup |

Group keys are `[a-z0-9-]` only (`isValidGroupKey`), so jobIds never contain `:`. Producers: web (add, "Check now",
re-checks, "Create PR"), the webhook route (`trigger: "webhook"`), and `deps-worker` itself (scheduler, auto PRs,
notifications).

## Scan (`processDepsScan`)

1. Skip when the module is off or the project is gone. Set `SCANNING`.
2. Read credentials (`GitHubAccess.readAccess`): App installation token (`contents: read`, `pull_requests: read`,
   narrowed to the repository) → the owner's OAuth token (public repositories) → anonymous. A private repository
   without the App → `scanError = "Install the GitHub App to check private repositories"`, `ERROR`, no retry. Every
   scan of a private repository re-checks the owner's `read` permission: lost access → `ERROR` ("You no longer have
   access…"), and a PR mode falls back to `NOTIFY` and releases PR ownership.
3. `fetchGitTree` (metadata by `githubRepoId`, so renames are followed; head; recursive tree with blob SHAs) →
   `detectManifests` → read blobs. Unchanged files come from Redis keyed by blob SHA (`deps:blob:<sha>`,
   `deps:lockread:<key>`, 7 days); every manifest is still re-parsed.
4. Look up each distinct `(ecosystem, name)` once (≤ 8 in flight), `selectTarget` per dependency, at most 1,000
   dependencies (warning beyond).
   Shared scan/update analysis reads ancestor registry configuration first. Dependencies using custom registries
   or repository sources become `UNSUPPORTED_SOURCE` before public lookups or manifest-only PR planning. Unreadable
   configuration fails closed; error reasons do not include registry URLs or credentials.
5. One transaction: upsert manifests (vanished ones cascade), upsert / delete `DependencyUpdate` rows. `firstSeenAt` /
   `notifiedAt` are kept while `targetVersion` is unchanged and reset when it changes. Project-level warnings (caps,
   unreadable files) are stored on the first manifest. Refresh `fullName`, `defaultBranch`, `isPrivate`,
   `lastScannedSha`; `nextScanAt = now + scanIntervalHours`, `IDLE`, `errorCount = 0`.
6. Refresh open PRs (`getPullRequestState`): merged → `MERGED`; closed → `CLOSED` and its targets' rows `DISMISSED`;
   head ≠ `headSha` → `EDITED` (notified once), **unless** it matches either SHA in a persisted branch-write intent or an update
   job for that group is waiting or running.
7. After commit: SSE `DEPS_SCAN_COMPLETED`, the digest (below), and with `AUTO_PR` + an installation, `deps-update`
   jobs for groups (within `maxOpenPrs`) whose planned targets differ from the open PR's `targets`, plus groups whose
   open PR has no planned updates any more (the job closes it). `EDITED` PRs are left alone.
8. Errors: GitHub rate limit → `scanQueue.rateLimit()` + `Worker.RateLimitError()`. 404 → `ERROR`, `errorCount++`;
   after 5 failures the next scan is in 7 days ("Check now" works any time). Anything else (registry 429 / 5xx,
   network) is rethrown; only the last attempt records `ERROR` and reschedules within ≤ 6 h. Manual scans publish
   `DEPS_SCAN_FAILED` with a user-safe message.

The scheduler enqueues projects with `nextScanAt` null or due and not `SCANNING` (or stale after 15 min), in
batches of 200.

## Planning (`plan.ts`, pure)

`selectTarget(candidates, dependency, policy, now)`, in order:

1. Unsupported spec → `UNSUPPORTED_SOURCE`. Drop deprecated, yanked, pre-release (unless `includePrereleases` and
   the current version is a pre-release of the same `major.minor`) and `requires-python`-incompatible versions.
2. An ignore rule without `versions` → `IGNORED`; with `versions` it removes the matching candidates. Patterns:
   `*` only at the start and / or end, case-insensitive, PyPI names PEP 503-normalized.
3. Current version = the lockfile's, else the lower bound of `declared`. Nothing newer (or no current version) →
   `UP_TO_DATE`: the row is deleted.
4. Only versions within `maxUpdateLevel` (major, or minor on `0.x`, counts as major) can be targets; none →
   `ABOVE_LEVEL`. `latestVersion` still shows the newest.
5. Younger than `minReleaseAgeDays` → the newest old-enough version above current, else `TOO_NEW`. A missing publish
   date counts as old enough.
6. `LOCKFILE_ONLY` and peer dependencies need the target inside `declared`; `BUMP` bumps the range (keeping its
   operator **and written precision**: `>=1.2` stays `>=1.2` for 1.2.5, which leaves nothing to commit without a
   lockfile). In both cases the newest eligible version the range admits is used; none → `BLOCKED_BY_RANGE`.
7. A target equal to the `DISMISSED` version stays `DISMISSED`; a newer one is `OUTDATED` again.

`targetVersion` is set for `OUTDATED` and `DISMISSED` rows only. `classifyUpdate` → `level` uses the `classifySemver`
thresholds.

`groupUpdates(outdated, groupMode, maxOpenPrs)`: `SINGLE` → `all`; `SEPARATE_MAJORS` → `all` + `major-<slug>` per major
dependency; `PER_DEPENDENCY` → `<eco>-<slug>` (every manifest using the name moves together). Majors sort last; only
the first `maxOpenPrs` groups get a slot. `groupCapability` disables "Create PR" for check-only managers (Yarn,
`bun.lockb`, pip-tools) and for lockfile groups when the sandbox is not configured; the web also disables it for
lockfile groups while the `deps-worker` heartbeat shows no reachable sandbox.

## Update pull request (`processDepsUpdate`)

1. Server-side checks (above). A refusal → `UnrecoverableError` with a user-safe message, SSE
   `DEPS_PULL_REQUEST_UPDATED { state: "FAILED", message }`. The installation lookup is strict: only a confirmed "not
   installed" (404) switches the project to `NOTIFY`; rejected App credentials or network errors fail the job.
2. Write token (`contents: write`, `pull_requests: write`, one repository). Fresh head + tree; the group is recomputed
   from stored rows plus registry data revalidated now (`ttlMs: 0`). Empty group → close the open PR with a comment,
   `CLOSED` (or `EDITED`, untouched, when someone else pushed to its branch).
3. Span edits (`rewrite/*`; spans are JS string offsets), structurally re-checked. Hashed requirements get the sha256
   of **every** file of the target version. Updates whose range already allows the target and that have no lockfile
   are listed in the PR as "Not included".
4. Lockfile groups: `POST /v1/lock` with the rewritten manifests, the current lockfile, the workspace manifests and
   the registry config files under the workspace root (`.npmrc`, `.yarnrc*`, `bunfig.toml`, `pip.conf`, `uv.toml`,
   `poetry.toml`, so the sandbox can refuse custom registries). No source code, never `.env*`. The worker validates
   the result (path, ≤ 20 MiB, parses, same format version, every planned dependency at its target).
5. Branch `repopulse/deps/<groupKey>`: edited by someone else → `EDITED`, stop (a pre-existing non-bot branch is a
   refusal); same content → no commit; else `commitFiles` (blobs → tree → commit without author, so GitHub shows
   `<slug>[bot]` → persist the prepared SHA in `DependencyBranchWriteIntent` → create or force-update the ref).
   A retry recognizes that exact prepared SHA, its observed previous head, or the stored PR head if the ref write never happened.
   A 409 / 422 race retries once from step 2. Clear the intent after the PR state is saved.
6. `upsertPullRequest` (title = commit subject, dependency names verbatim; body table with names, paths and versions
   in code spans, so `@scope/name` never becomes a mention, + "Not included" + hidden
   `<!-- repopulse:deps:<groupKey> -->` marker; no labels, no auto-merge). Save `headSha` and `targets` (every planned
   target, no-ops included). Notify `opened`, or `updated` only when a commit brought new versions.

## Sandbox contract (`sandbox-contract.ts`, zod on both sides)

- `POST /v1/lock`, `Authorization: Bearer <DEPS_SANDBOX_TOKEN>`, body `{ packageManager: NPM|PNPM|BUN|UV|POETRY,
  workdir, files: { path, contentBase64 }[] (≤ 2,000), upgrade: { name, version }[], lockfileOnly, expectLockfile }`,
  ≤ 30 MiB. Response `{ ok: true, lockfile }` or `{ ok: false, code, stderrTail }`, always matching the schema.
- Status: 400 `BAD_REQUEST`, 401 `UNAUTHORIZED`, 413 `TOO_LARGE`, 503 `BUSY` (one job at a time, `Retry-After: 10`;
  the worker retries), 500 `INTERNAL`. Job outcomes are 200: `UNSUPPORTED_REGISTRY`, `UNSUPPORTED_TOOL_VERSION`,
  `TIMEOUT`, `COMMAND_FAILED`, `LOCKFILE_MISSING`, an oversized lockfile.
- `GET /health` (no auth) → `{ status: "ok", tools: { npm, pnpm, bun, uv, poetry } }`. The worker's heartbeat
  carries it to Admin → Dependencies.
- Each job: fresh dir under the tmpfs (removed after), scripts disabled, `UV_NO_BUILD=1`, no Python downloads, pnpm
  package-manager auto-download off, Corepack removed, timeout `DEPS_SANDBOX_TIMEOUT_MS` (kills the process group),
  output capped at 1 MiB. `.npmrc`, `.yarnrc*`, `.pnpmfile.*`, `bunfig.toml`, `pip.conf`, `poetry.toml`, `uv.toml`,
  `.env*` are deleted; a **non-default registry** in them, in `pyproject.toml` (`[tool.uv.index]`, Poetry sources)
  or in `pnpm-workspace.yaml` → `UNSUPPORTED_REGISTRY` (never silently stripped: dependency confusion).
- A project that pins another tool major (`packageManager`, `devEngines`) or a lockfile format the pinned tool would
  change → `UNSUPPORTED_TOOL_VERSION`; the output format must equal the input's.

| Manager | Command (cwd = workspace root) | `LOCKFILE_ONLY` |
| --- | --- | --- |
| npm | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | `npm update <names> --package-lock-only …` |
| pnpm | `pnpm install --no-frozen-lockfile --lockfile-only --ignore-scripts --ignore-pnpmfile` | `pnpm update [--recursive] --no-save --lockfile-only … <names>` |
| Bun | `bun install --lockfile-only --ignore-scripts --no-env-file` | `bun update <names>`, restore the manifests, then `bun install …` |
| uv | `uv lock --upgrade-package <name>==<version> …` | same |
| Poetry | `poetry --no-plugins --no-interaction --no-ansi lock` | `poetry … update --lock <names>` |

Image pins (`apps/deps-sandbox/Dockerfile`, `node:26-trixie-slim`, Python 3.13, `tini`, uid 10001): npm 12.2.1,
pnpm 12.14.0, Bun 1.4.3, uv 0.13.1, Poetry 2.5.1. Re-check `commands.ts` (flags, lockfile format constants) on every
bump.

## Supported ecosystems

| Package manager | Manifest | Current versions from | Update PR |
| --- | --- | --- | --- |
| npm / pnpm / Bun | `package.json` (+ workspaces, `pnpm-workspace.yaml`) | `package-lock.json` v2/v3, `npm-shrinkwrap.json`, `pnpm-lock.yaml` v9, `bun.lock` | yes, lockfile from the sandbox |
| Bun (binary) | `package.json` | declared range (`bun.lockb` unreadable) | check only |
| Yarn | `package.json` | `yarn.lock` (classic, Berry) | check only |
| none (npm / PyPI) | `package.json` / `pyproject.toml` without a lockfile | declared range | yes, manifest only |
| pip | `requirements*.txt`, `requirements/*.txt`, `constraints*.txt` (`-r` / `-c` followed, depth 5) | the `==` pins | yes, text edit + hashes |
| uv / Poetry | `pyproject.toml` (PEP 621, PEP 735, `[tool.poetry]`) | `uv.lock` / `poetry.lock` | yes, lockfile from the sandbox |
| pip-tools | `requirements.in` (declared) + compiled `.txt` (its lockfile) | the compiled pins | check only |

Detection order for npm-family managers: the `packageManager` field, then the root lockfile (`pnpm-lock.yaml` >
`bun.lock` > `bun.lockb` > `yarn.lock` > `npm-shrinkwrap.json` > `package-lock.json`). Skipped directories:
`node_modules`, `.venv`, `venv`, `vendor`, `dist`, `build`, `.git`, `fixtures`, `__fixtures__`, `testdata`,
`examples`. At most 25 manifests (shallowest first) unless `manifestPaths` is set. Unsupported specs (git, file,
link, workspace, `catalog:`, `npm:` aliases, URLs, `*` / dist-tags, npm / pnpm `overrides`, Yarn `resolutions`) are
listed as `UNSUPPORTED_SOURCE`, not dropped. `--index-url` makes the whole requirements file `UNSUPPORTED_SOURCE`;
`--extra-index-url` only warns.

Registries: npm abbreviated packument (+ the full document's `time` only when the age policy needs it), PyPI Simple
JSON (PEP 691 / 700: upload time, yanked, `requires-python`, sha256) and `/pypi/<name>/json` for `project_urls`.
Redis `deps:reg:<namespace>:<name>`: fresh for 1 h, then revalidated with `If-None-Match`, kept 7 days.

## Webhooks (Part E, optional)

`POST /api/github-app/webhook`, checked in this order: 413 (body > 5 MiB) → 404 (no App) → 503 (no or unreadable
secret) → 401 (bad `X-Hub-Signature-256`) → 204 (module off, or an event other than `push` / `pull_request`) → 400
(not JSON) → 202 `{ queued }`. It writes nothing; it only enqueues `deps-scan` (`trigger: "webhook"`):

- `push` to a branch equal to a project's stored `defaultBranch` → every such project (any user) whose dependency
  files changed (any manifest / lockfile name, or one of its explicit `manifestPaths`), or all of them when the
  commit list is missing, empty or at GitHub's 2,048 cap.
- `pull_request` `closed` on a `repopulse/deps/*` head → the PR owner's project.

Polling stays the fallback, so a lost delivery only delays a scan.

## Redis keys

| Key | Written by | TTL |
| --- | --- | --- |
| `deps:worker:heartbeat` | `deps-worker`, every 30 s (`{ at, sandbox: health \| null }`) | 90 s |
| `deps:reg:<npm\|npm-time\|pypi\|pypi-meta>:<name>` | registry cache (body + ETag) | 7 days |
| `deps:blob:<sha>`, `deps:lockread:<key>` | blob / lockfile-read caches. Private manifests' text lives here | 7 days |

## Local development

`pnpm dev` also starts `deps-worker` (health `:3002`) and `deps-sandbox` (`:3003`). The sandbox then runs the tools
installed on your machine with **no isolation**; set `DEPS_SANDBOX_URL=http://127.0.0.1:3003` for the worker and
`DEPS_EGRESS_PROXY=` (empty) for the sandbox, or leave lockfile PRs alone locally. Enable the module in Admin →
Dependencies first. Adding an ecosystem or package manager: [recipes.md](./recipes.md#add-a-dependency-ecosystem-or-package-manager).

## Known limits

- Direct dependencies only; no advisories, no Yarn / `bun.lockb` / pip-tools lockfile regeneration, public registries
  only.
- Poetry may build sdists (`setup.py`) inside the sandbox to resolve metadata. The job runs as the same uid as the
  sandbox server, so it could read the bearer token from `/proc` (the token only grants sandbox use).
- pnpm 12's minimum release age may reject very new targets (`COMMAND_FAILED`). uv with a `requires-python` that
  excludes 3.13 is untested.
- Squid filters by host name only (domain fronting through an allowed CDN is not prevented; there are no secrets to
  steal).
- GitHub's API can't activate the App webhook or change its events: the super admin ticks them on GitHub (Admin →
  GitHub App lists the steps).
- A force-push between the branch check and the ref update can be overwritten (GitHub's ref API has no
  compare-and-swap). A second "edited" notice for the same PR within 7 days is deduplicated.
