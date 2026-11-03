# Slice 08 — Implementation Summary

**Spec:** [`slice_08_dependency_updates.md`](./slice_08_dependency_updates.md)
**Status:** Implemented: Part A (projects and checks), Part B (GitHub App), Part C (manifest-only update PRs), Part D
(sandboxed lockfile regeneration) and Part E (webhooks). Two items were still landing when this summary was written
and are documented as behavior: the per-scan read-permission re-check of private repositories, and "Create PR" being
disabled while the `deps-worker` heartbeat shows no reachable sandbox. See §5 for what was verified.
**Date:** 2026-11-03

---

## 1. Files

```text
packages/db/prisma/schema.prisma                     Dependency* models + enums, NotificationEvent, NotificationRule.events,
                                                       User.githubLogin, InstanceSettings.depsEnabled + githubApp*
packages/db/prisma/migrations/20261103090000_dependency_projects/   NEW (Part A)
packages/db/prisma/migrations/20261103100000_github_app/            NEW (Part B)
packages/db/src/instance-settings.ts                 loadGitHubAppSettings, GITHUB_APP_SETTINGS_SELECT, GitHubAppKeyUnreadableError,
                                                       loadDepsEnabled

packages/deps/                                       NEW @repopulse/deps (detect, manifests, lockfiles, versions, registries,
                                                       plan, rewrite, pull-request, sandbox-contract, limits; 184 tests)
packages/github/src/{app,app-hook,git-tree,git-write}.ts (+ tests)  NEW GitHub App, webhook config / signatures, tree with blob
                                                       SHAs, Git Data API writes and PR helpers (@octokit/auth-app 8.3.1)
packages/queue/src/deps.ts                           NEW queue names, payloads, options, jobIds
packages/queue/src/events.ts (+ test)                DEPS_SCAN_COMPLETED, DEPS_SCAN_FAILED, DEPS_PULL_REQUEST_UPDATED
packages/notifications/src/dependency-dispatcher.ts, formatters/dependencies.ts (+ tests)   NEW

apps/deps-worker/                                    NEW (scheduler, scan, update, notify processors; GitHub access; Redis caches;
                                                       sandbox client + lockfile validation; health :3002; heartbeat; Dockerfile)
apps/deps-sandbox/                                   NEW (node:http server, run-lock, commands, tool detection; Dockerfile)
deploy/deps-egress/{squid.conf,README.md}            NEW allowlist proxy

apps/worker/src/processors/{fan-out,notification.processor,repo-tags}.ts   RELEASES in events; EVENT_DISABLED skip
apps/web/src/app/(dashboard)/dependencies/**         NEW list + detail (+ not-found)
apps/web/src/app/(dashboard)/admin/{github-app,dependencies}/page.tsx      NEW
apps/web/src/app/api/github-app/{manifest/callback,webhook}/route.ts       NEW
apps/web/src/server/actions/{dependencies,github-app,dependencies-admin}.ts (+ tests)   NEW; notifications.ts: events
apps/web/src/server/{deps-status,github-app,github-app-webhook,deps-webhook-queue}.ts, queries/{dependencies,github-app}.ts
apps/web/src/lib/{dependency-settings,dependency-list-filters,github-app,notification-events}.ts (+ tests)
apps/web/src/components/dependencies/*, admin/{deps-enabled-toggle,github-app-settings}.tsx,
  notifications/notification-event-checkboxes.tsx    NEW; admin-nav, app-sidebar, sse-listener, rule form / item, repository page card
apps/web/src/lib/auth.ts                             stores githubLogin on sign-in

docker-compose.coolify.yml, .env.example, scripts/{setup-env,sync-env}.mjs   three services, deps_sandbox network, DEPS_* variables
docs/dependencies.md (NEW), docs/{README,architecture,data-model,packages,configuration,deployment,notifications,
  auth-and-access,web-app,worker,recipes}.md, CHANGELOG.md
```

## 2. What shipped, per part

- **A. Projects and checks.** Per-user projects (`(userId, githubRepoId)`), added from subscriptions (≤ 20), by URL or
  from the repository settings page; at most 50 per user. `deps-worker` reads the default-branch tree (App token →
  OAuth → anonymous), detects manifests, reads lockfiles, queries npm / PyPI through a Redis cache with ETag
  revalidation, plans with the project policy and stores the outdated set in one transaction. Digests go to rules
  with `DEPENDENCY_UPDATES`, once per target version. The module is off by default (Admin → Dependencies).
- **B. GitHub App.** Manifest flow with a state cookie, or a manual form validated against `GET /app`; key and secret
  encrypted. Installation tokens narrowed to one repository; collaborator permission checks with `User.githubLogin`
  (re-resolved from `githubId` on a 404).
- **C. Manifest-only PRs.** Span edits for `package.json`, `pyproject.toml` and `requirements*.txt` (hash sets
  replaced with every sha256 of the target), structural re-checks, a bot branch per group, Git Data API commits
  without author, one PR per group, `EDITED` hands-off.
- **D. Sandbox.** `deps-sandbox` (no secrets, internal network, read-only rootfs, tmpfs, `cap_drop: ALL`) runs npm
  12.2.1 / pnpm 12.14.0 / Bun 1.4.3 / uv 0.13.1 / Poetry 2.5.1 in lockfile-only mode with scripts disabled behind the
  `deps-egress` Squid allowlist. The worker validates every returned lockfile.
- **E. Webhooks.** `POST /api/github-app/webhook` verifies the signature and enqueues scans for pushes that change
  dependency files and for closed `repopulse/deps/*` PRs; "Enable webhooks" sets the hook URL and secret.
- **Notifications.** `NotificationRule.events`; the release worker requires `RELEASES`; dependency formatters for
  every deliverable channel and custom webhook events `dependencies.outdated` / `dependencies.pull_request`.

## 3. Deviations from the spec

| Spec | Implemented | Why |
| --- | --- | --- |
| No `notifyOnFirstScan` column | `DependencyProject.notifyOnFirstScan` | The Add dialog's "Notify about what is outdated now" must survive until the first scan runs. |
| — | Index on `DependencyProject.githubRepoId` | Webhooks and PR ownership look projects up by repository. |
| `selectTarget`: no newer version → row deleted | Returns `UP_TO_DATE` (the scan deletes the row) | Same effect, explicit status for tests. |
| `LOCKFILE_ONLY` / upper bound → `BLOCKED_BY_RANGE` | Falls back to the newest eligible in-range version; `BLOCKED_BY_RANGE` only when none | An in-range update is still useful. |
| `bumpSpecifier` `>=1.2` → `>=1.4` | Bumps keep the written precision (`>=1.2` stays for 1.2.5) | Never invents precision; such updates are "Not included" without a lockfile. |
| Strip risky config, `UNSUPPORTED_REGISTRY` when registry entries existed | Config files are deleted; any non-default registry in `.npmrc`, `.yarnrc*`, `bunfig.toml`, `pip.conf`, `uv.toml`, `poetry.toml`, `pnpm-workspace.yaml` or pyproject indexes → `UNSUPPORTED_REGISTRY`. The worker sends those files for that check; `.env*` is never sent and is deleted | Silently re-locking against the public registry would be dependency confusion. |
| Sandbox request `{ packageManager, workdir, files, upgrade, expectLockfile }` | Adds `lockfileOnly` | npm / pnpm / Bun / Poetry need different commands for `LOCKFILE_ONLY`. |
| Commands per §3.10 | pnpm `install --no-frozen-lockfile`; Bun `LOCKFILE_ONLY` = `update`, restore manifests, `install`; Poetry `LOCKFILE_ONLY` = `update --lock <names>`; Bun `--no-env-file`; Poetry `--no-plugins` | Verified against the pinned tools in the built image. |
| `deps-notify` payload `scanId \| prId` | Digest: `scanId` (hash of row id + target version) + `updateIds`; PR: `prId`, `event`, `dedupKey` | A newer target must never be deduplicated away; PR events need their kind. |
| SSE `DEPS_PULL_REQUEST_UPDATED` states `OPEN/MERGED/CLOSED/EDITED` | Adds `FAILED` with a user-safe `message` | The PR card shows why a job was refused. |
| Scan reads with `fetchRepoTree` | New `fetchGitTree` (metadata by id, blob SHAs) | Unchanged files are skipped by blob SHA; renames are followed. |
| Paused after 5 failures | Next scan in 7 days; "Check now" always works; transient last-attempt failures retry within ≤ 6 h | Same intent, no separate paused state. |
| Ignore rule → re-run `selectTarget` on stored rows | A plain rule marks matching rows `IGNORED` at once; a version-range rule and rule removal queue a re-check (bypassing the cooldown) | Un-ignoring or a range needs registry data the rows don't keep. |
| Add dialog: PR modes per repository | PR modes only when adding a single repository | Each PR mode needs a `write` check and claims PR ownership. |
| Enable webhooks also sets events / active | Sets URL + secret; the admin page lists the manual steps | GitHub's API can't change the hook's active flag or events. |
| `deps-update` installation check | Strict lookup: only a confirmed 404 switches to `NOTIFY`; auth / network errors fail the job | A transient error must not drop a user's PR mode. |
| Empty group → close the PR | Closed with a comment, or marked `EDITED` when someone else pushed to its branch | Hands-off applies to closing too. |
| Commit / title mention safety | Names verbatim in commit messages and titles; the PR body puts names in code spans | Code spans never link mentions, and names stay exact. |
| Sandbox image | `node:26-trixie-slim` + `tini` (not Alpine) | Bun and uv release binaries are glibc builds. |
| — | Sandbox env `DEPS_EGRESS_PROXY`, `PORT`, `DEPS_SANDBOX_TMP_DIR` | Image / local-dev settings; not in `.env.example`. |

## 4. Known limitations

- A force-push between the branch check and the ref update can be overwritten: GitHub's ref API has no
  compare-and-swap.
- Scans ignore `.npmrc` registries, so a private package that shadows a public name can still get a manifest-only PR
  (lockfile PRs are refused by the sandbox's registry check).
- A digest can be lost if Redis fails right after `notifiedAt` is set (the rows count as announced).
- A second "edited" notice for the same PR within 7 days is deduplicated by the notify jobId.
- Poetry may build sdists (`setup.py`) inside the sandbox. Jobs run as the same uid as the sandbox server and could
  read its bearer token from `/proc` (the token only grants sandbox use).
- pnpm 12's minimum release age may reject very new targets; uv with a `requires-python` that excludes Python 3.13 is
  untested.
- Squid filters by host name only (domain fronting through an allowed CDN is not prevented).
- Private manifests' text is cached in Redis (7 days) to skip unchanged blobs.
- Whether Coolify keeps a custom `internal: true` network was not checked on a real Coolify instance; the documented
  fallback is a host firewall rule ([docs/deployment.md](../docs/deployment.md)).

## 5. Verification

- During the docs pass: `pnpm --filter "./packages/*" build && pnpm typecheck && pnpm lint && pnpm test` passed
  (deps 184, github 154, notifications 101, queue 32, db 14, worker 91, deps-worker 67, deps-sandbox 51, web 336
  tests), and `pnpm --filter @repopulse/web build` passed. This ran before the last review-pass changes and the two
  in-progress items (header): run it again once they land.
- The sandbox commands were run end to end in the built image through the egress proxy by the implementing agent
  (see `apps/deps-sandbox/src/commands.ts`).
- **Not verified here:** applying the two migrations to a real database (`pnpm db:migrate:deploy` + the
  `migrate diff` check), `docker compose -f docker-compose.coolify.yml up --build` with all services healthy, a full
  scan → PR run against a scratch GitHub repository with a real App, the egress allowlist test from
  `deploy/deps-egress/README.md`, the Coolify network check, and the pages in a browser.
