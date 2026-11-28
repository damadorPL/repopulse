# Dependencies Module Guide

> **Summary:** cross-service overview of RepoPulse's optional Dependencies module, which checks users' own repositories ("projects") for outdated direct npm, Bun, and PyPI dependencies, sends digest/PR notifications, and opens update pull requests with regenerated lockfiles through the RepoPulse GitHub App. Off by default until the super admin enables Admin → Dependencies.
>
> **Related Docs:** [../apps/deps-worker.md](../apps/deps-worker.md) · [../apps/deps-sandbox.md](../apps/deps-sandbox.md) · [../packages/deps.md](../packages/deps.md) · [../packages/github.md](../packages/github.md) · [../packages/notifications.md](../packages/notifications.md) · [../CONTRACTS.md](../CONTRACTS.md) · [./auth-and-access.md](./auth-and-access.md)

## Component Map

| Concern | Guide / Location |
| --- | --- |
| Pure parsing, lockfiles, versions, registries, planning, rewrites, PR text, limits, sandbox contract | [../packages/deps.md](../packages/deps.md) (`packages/deps/src/**`) |
| BullMQ workers, scans, PR commits, outbox notifications, heartbeat | [../apps/deps-worker.md](../apps/deps-worker.md) (`apps/deps-worker/src/**`) |
| Isolated lockfile HTTP server, tool flags, image pins | [../apps/deps-sandbox.md](../apps/deps-sandbox.md) (`apps/deps-sandbox/src/**`) |
| Squid egress allowlist | `deploy/deps-egress/squid.conf` (+ `README.md`) |
| Queue contracts & Redis keys | [../CONTRACTS.md](../CONTRACTS.md) (`packages/queue/src/deps.ts`) |
| GitHub App, Git Data API, webhook signature | [../packages/github.md](../packages/github.md) (`packages/github/src/{app,app-hook,git-tree,git-write}.ts`) |
| Dependency notifications | [../packages/notifications.md](../packages/notifications.md#lifecycle--rule-events) |
| Web UI, Server Actions, queries, webhook route | [../apps/web.md](../apps/web.md) (`apps/web/src/app/(dashboard)/dependencies/**`, `server/actions/dependencies.ts`, `app/api/github-app/webhook/route.ts`) |

## Services and Trust Boundaries

| Service | Holds | Network | Does |
| --- | --- | --- | --- |
| `deps-worker` | `DATABASE_URL`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY` (decrypts App key, SMTP password & OAuth tokens), installation tokens (memory only), `DEPS_SANDBOX_TOKEN` | `default` + `deps_sandbox` | Scans, update PRs, notifications. Parses untrusted files as text only |
| `deps-sandbox` | `DEPS_SANDBOX_TOKEN` (stripped from `process.env` at startup; `docker-entrypoint.sh` `env -i`) | `deps_sandbox` only (`internal: true`) | `POST /v1/lock`: runs `npm` / `pnpm` / `Bun` / `uv` / `Poetry` in lockfile-only mode, returns lockfile |
| `deps-egress` | nothing | `default` + `deps_sandbox` | Squid: `CONNECT` on 443 to `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`; denies everything else, private ranges included |
| `web` | as core | `default` | Pages, actions, `POST /api/github-app/webhook` (enqueue only) |

GitHub App credentials are **not** environment variables: they live encrypted on `InstanceSettings`; `web` reads them per call (`loadGitHubAppSettings`), while `deps-worker` caches them for 15 s via `createCachedLoader`, so Admin changes apply within seconds without a restart.

## Lifecycle

- **Projects (`DependencyProject`)** are per user, unique on `(userId, githubRepoId)`, and independent of release subscriptions: `repositoryId` only powers the quick-add picker and the "Tracked" badge (`SetNull`).
- **Adding (`addDependencyProjectsAction`):** 1–20 sources, max 50 projects per user. Reads the repo with the user's OAuth token, falling back to an App installation token for private repositories (requires the App installed **and** user's `read` permission). PR mode is offered only for a single repository and requires `write`. First scan is queued immediately (`trigger: "add"`), and unless `notifyOnFirstScan` was ticked, marks initial outdated rows notified without sending.
- **PR ownership (`DependencyPrOwner`):** switching to `MANUAL_PR` / `AUTO_PR` claims `DependencyPrOwner` (PK `githubRepoId`) inside the settings transaction (`CONFLICT` naming the owner otherwise); `NOTIFY` or removing the project releases it. Losing `read` access on a private repository during a scan, or App uninstallation / losing `write` access during an update, switches a PR-mode project to `NOTIFY`, releases ownership, and sends an `access_lost` notification.
- **Module off (`InstanceSettings.depsEnabled = false`):** sidebar link is hidden, `/dependencies` explains it, actions that queue work return `UNAVAILABLE`, every processor returns `SKIPPED` / `DISABLED`, and the webhook route returns `204`.

## Webhooks Overview

`POST /api/github-app/webhook` (public, `X-Hub-Signature-256` HMAC-SHA256) performs no database writes and only enqueues `deps-scan` (`trigger: "webhook"`) on `push` (default branch dependency file changes) and `pull_request` `closed` (`repopulse/deps/*` branches). Scheduled polling remains the fallback. Full check order and contract: [../CONTRACTS.md](../CONTRACTS.md#github-app-webhook-contract).

## Local Development

`pnpm dev` starts `deps-worker` (health `:3002`) and `deps-sandbox` (`:3003`). Locally, the sandbox runs host-installed tools with **no container isolation**: set `DEPS_SANDBOX_URL=http://127.0.0.1:3003` for `deps-worker` and `DEPS_EGRESS_PROXY=` (empty) for `deps-sandbox`, or skip lockfile PRs locally. Enable the module in Admin → Dependencies first. Adding an ecosystem or package manager: [recipes.md](./recipes.md#add-a-dependency-ecosystem-or-package-manager).

## Known Limits

- Direct dependencies only; no advisories, no Yarn / `bun.lockb` / pip-tools lockfile regeneration, public registries only.
- Poetry may build sdists (`setup.py`) inside the sandbox to resolve metadata. The job runs as the same uid as the sandbox server, so it could read the bearer token from `/proc` (the token grants only sandbox use).
- pnpm 12's minimum release age may reject very new targets (`COMMAND_FAILED`). `uv` with a `requires-python` that excludes 3.13 is untested.
- Squid filters by hostname only (domain fronting through an allowed CDN is not prevented; there are no secrets inside the sandbox to steal).
- GitHub's API cannot activate the App webhook or subscribe to events: the super admin ticks them on GitHub (Admin → GitHub App lists the steps).
- A force-push between the branch check and the ref update can be overwritten (GitHub's ref API has no compare-and-swap). A second "edited" notice for the same PR within 7 days is deduplicated.
