# Dependencies Worker (`apps/deps-worker`)

> **Summary:** dedicated Node process running the Dependencies module's four BullMQ workers (`deps-scheduler`, `deps-scan`, `deps-update`, `deps-notify`), a 5-second `DependencyNotificationOutbox` dispatcher, a 30-second Redis heartbeat (`deps:worker:heartbeat`), and a health server on `:3002`. Never imports `apps/worker` and never executes third-party repository code.
>
> **Related Docs:** [../guides/dependencies.md](../guides/dependencies.md) · [./deps-sandbox.md](./deps-sandbox.md) · [../CONTRACTS.md](../CONTRACTS.md) · [../packages/deps.md](../packages/deps.md)

## Files

| Concern | File |
| --- | --- |
| Entrypoint, graceful shutdown, `lockDuration` | `apps/deps-worker/src/index.ts` |
| Env config (`DEPS_SANDBOX_URL`, `DEPS_SANDBOX_TOKEN`, `DEPS_SCAN_CRON`, concurrency) | `apps/deps-worker/src/config.ts` |
| Queue creation, teardown, `deps-scheduler` registration | `apps/deps-worker/src/queues.ts` |
| Health server (`:3002`, `DEPS_HEALTH_PORT`), Redis connection, Pino logger | `apps/deps-worker/src/{health,redis,logger}.ts` |
| Heartbeat (`deps:worker:heartbeat` + sandbox `/health` probe) | `apps/deps-worker/src/heartbeat.ts` |
| Durable notification outbox (`storeNotificationIntents`, 5 s flusher) | `apps/deps-worker/src/notification-outbox.ts` |
| Read / write credentials (App installation tokens, OAuth fallback) & GitHub API wrapper | `apps/deps-worker/src/{github-access,github-api}.ts` |
| Shared scan / update analysis (read tree, parse, registry lookup, plan) | `apps/deps-worker/src/analysis.ts` |
| Redis caches (registry, batched blobs, snapshots trees, lockfile reads) | `apps/deps-worker/src/registry-cache.ts` |
| Sandbox HTTP client + `validateLockfile` | `apps/deps-worker/src/sandbox-client.ts` |
| Processors & shared helpers | `apps/deps-worker/src/processors/deps-{scheduler,scan,update,notify}.processor.ts`, `notify-jobs.ts`, `repo-access.ts` |

## Rules

- **MUST NOT** execute package managers, build backends, or repository scripts inside `deps-worker`. Parse manifests and lockfiles in pure TypeScript (`@repopulse/deps`) and delegate lockfile regeneration to `deps-sandbox`.
- **MUST** validate every lockfile returned by `deps-sandbox` (`validateLockfile` in `sandbox-client.ts`: path, ≤ 20 MiB, parses cleanly, same format version, every planned dependency at its target).
- **MUST** re-check on **every** `deps-update` job: `InstanceSettings.depsEnabled`, project mode ≠ `NOTIFY` (and `AUTO_PR` for automatic jobs), `DependencyPrOwner`, App installation, and owner's `write` / `maintain` / `admin` collaborator permission.
- **MUST NOT** overwrite a bot branch whose head differs from stored `headSha` (`EDITED`, hands off), except when matching a persisted `DependencyBranchWriteIntent.commitSha` / `previousHeadSha` from an interrupted write.
- **MUST NOT** put `deps-sandbox` stderr tails in PRs, SSE events, or notifications (sanitized tail goes to the BullMQ job log only).
- **MUST NOT** import `apps/worker` (`passesDependencyNotificationLevel` is an intentional duplicate of `passesNotificationLevel`).
- **MUST** exit immediately with `SKIPPED` / `DISABLED` when `InstanceSettings.depsEnabled` is `false`.

## Queues & Processors

Queue specs (`DEPS_QUEUE_NAMES`) are documented in [../CONTRACTS.md](../CONTRACTS.md#dependencies-queues-deps_queue_names-consumed-by-appsdeps-worker).

### `deps-scheduler.processor.ts` → `processDepsSchedulerTick`

- Runs on `DEPS_SCAN_CRON` (default `17 * * * *`) and once on startup.
- Enqueues `deps-scan` in batches of 200 for projects with `nextScanAt` null or due and not `SCANNING` (or stale after 15 min).

### `deps-scan.processor.ts` → `processDepsScan`

1. Skip if module is off or project is gone. Mark `SCANNING`.
2. Resolve read credentials (`GitHubAccess.readAccess`): App installation token (`contents: read`, `pull_requests: read`, scoped to the repository) → owner's OAuth token (public repos) → anonymous. Private repo without App → `scanError = "Install the GitHub App to check private repositories"`, `ERROR`, no retry. Private repos always re-check owner's `read` permission; lost access sets `ERROR`, switches PR mode to `NOTIFY`, and releases PR ownership.
3. `fetchGitTree` (metadata by `githubRepoId` so renames are followed; head SHA; recursive tree with blob SHAs, short-circuited via `knownCommitSha` + 24 h Redis `deps:tree:<repoId>:<sha>` cache) → `detectManifests` → read blobs (batched via Redis `MGET`/pipeline 7-day `deps:blob:<sha>`, `deps:lockread:<key>`, single-parse `prepareLockfile` shared across workspace manifests).
4. Check ancestor registry config first (custom registries or repo sources become `UNSUPPORTED_SOURCE`; unreadable config fails closed without leaking URLs/credentials). Look up each distinct `(ecosystem, name)` once (≤ 8 in flight), run `selectTarget` per dependency (max 1,000 dependencies; warning beyond).
5. Single DB transaction: delete vanished `DependencyManifest` rows (cascades), create new manifests (`createManyAndReturn`) and update changed ones in parallel, update changed `DependencyUpdate` rows via a bulk `UPDATE ... FROM jsonb_to_recordset(...)` query (falling back to 50-row parallel chunks for a single update or when `$executeRaw` is unavailable; keeping `firstSeenAt` / `notifiedAt` while `targetVersion` is unchanged and resetting both on a new target), delete stale rows, create new rows in 500-row `createMany` batches, store project-level warnings on first manifest, refresh `fullName`, `defaultBranch`, `isPrivate`, `lastScannedSha`, set `nextScanAt = now + scanIntervalHours`, `IDLE`, `errorCount = 0`.
6. Refresh open PRs (`getPullRequestState`, bounded concurrency 4): merged → `MERGED`; closed → `CLOSED` + targets `DISMISSED`; head ≠ `headSha` → `EDITED` (notified once), unless matching a persisted `DependencyBranchWriteIntent` or an active/waiting update job for that group.
7. After commit: publish SSE `DEPS_SCAN_COMPLETED`; run `queueDigest` (separate DB transaction marking eligible outdated rows notified and storing `DependencyNotificationOutbox` intents — first scan marks notified silently unless `notifyOnFirstScan` — then flushing the outbox); and if `AUTO_PR` + App installed, queue `deps-update` for groups (within `maxOpenPrs`) whose planned targets differ from the open PR's `targets` or whose open PR now has no planned updates (closes PR). `EDITED` PRs are left alone.
8. Errors: GitHub rate limit → `scanQueue.rateLimit()` + `Worker.RateLimitError()`. 404 → `ERROR`, `errorCount++` (after 5 failures, next scan in 7 days; manual "Check now" always works). Transient errors rethrow; final attempt records `ERROR` and reschedules ≤ 6 h. Manual scans publish `DEPS_SCAN_FAILED`.

### `deps-update.processor.ts` → `processDepsUpdate`

1. Server-side re-checks (above). Refusals throw `UnrecoverableError` with a user-safe message and emit SSE `DEPS_PULL_REQUEST_UPDATED { state: "FAILED", message }`. Installation lookup is strict: only confirmed 404 switches the project to `NOTIFY` and sends `access_lost`.
2. Obtain write token (`contents: write`, `pull_requests: write`, single repository). Fetch fresh head + tree; recompute group from stored rows + live registry data (`ttlMs: 0`). Empty group → close open PR with comment (`CLOSED`, or `EDITED` untouched if externally pushed).
3. Apply span edits (`rewrite/*`) and structurally re-check. Hashed requirements include sha256 hashes of **every** file of the target version. Range-compatible updates without a lockfile go into the PR's "Not included" section.
4. Lockfile groups: `POST /v1/lock` to `deps-sandbox` with rewritten manifests, current lockfile, workspace manifests, and registry config files under the lockfile's directory (`.npmrc`, `.yarnrc`, `.yarnrc.yml`, `bunfig.toml`, `.bunfig.toml` for JS; `pip.conf`, `pip.ini`, `uv.toml`, `poetry.toml`, plus `.python-version` for Python; ancestor registry configs above the lockfile directory are enforced earlier during analysis) — no source code, never `.env*`. Validate returned lockfile (`validateLockfile`).
5. Branch `repopulse/deps/<groupKey>`: if externally edited → `EDITED`, stop (pre-existing non-bot branch is a refusal); unchanged content → skip commit; else `commitFiles` (blobs → tree → commit without author so GitHub attributes `<slug>[bot]`) → persist `DependencyBranchWriteIntent` (`commitSha`, `previousHeadSha`) before changing ref → create or force-update ref. Retries recognize prepared SHA / `previousHeadSha` / stored `headSha`. A 409/422 retries once from step 2. Clear intent after saving PR state.
6. `upsertPullRequest` (commit subject title, dependency names verbatim; body table with names/paths/versions in backticks so `@scope/name` does not mention users + "Not included" + hidden `<!-- repopulse:deps:<groupKey> -->` marker; no labels, no auto-merge). Save `headSha` and `targets`. Queue `deps-notify` (`opened`, or `updated` only on new-version commit).

### `deps-notify.processor.ts` & `notification-outbox.ts`

- **Outbox (`notification-outbox.ts`):** `storeNotificationIntents` persists `DependencyNotificationOutbox` rows inside `deps-scan`'s digest transaction (`createMany` with `skipDuplicates`; PR event notifications enqueue directly via `notifyPullRequestEvent` in `notify-jobs.ts`); `startNotificationOutbox` checks cached `depsEnabled` and drains up to 20 batches of 100 rows (2,000 rows/tick, with an in-process single-flight guard and deletion of corrupt rows failing `parseDepsNotifyJobData`) every 5 s via `queue.addBulk` (deterministic jobIds), deleting rows only after BullMQ acknowledges enqueueing.
- **`processDepsNotify`:** re-checks module switch, project, rule (enabled, owner, event, untagged, deliverable channel), notification level, and (for PR events) mode and PR existence; fetches user email only for `EMAIL_INSTANT` rules without an explicit destination and calls `dispatchDependencyNotification()`. Classifies errors like `apps/worker`'s notification processor.

## Lifecycle & Testing

- Startup: `readConfig()` → health server (`:3002`) → `prisma.$connect()` → Redis & queues → 4 BullMQ workers (`lockDuration: 120_000` on scan/update; `loadDepsEnabled`, `loadGitHubAppSettings`, and `loadSmtpSettings` wrapped in 15 s `createCachedLoader` caches) → `startHeartbeat` (`deps:worker:heartbeat`, every 30 s, 90 s TTL) → `startNotificationOutbox` → `registerSchedule`.
- `SIGTERM`/`SIGINT`: stops heartbeat and outbox flusher, calls `worker.cancelAllJobs("shutdown")`, drains workers, closes SMTP transports, queues, health server, Redis, and Prisma within 25 s.
- Tests pass fake dependencies (`prisma`, `redis`, `sandbox`, `github`, etc.) to processors; rebuild `packages/*` before running worker tests.
