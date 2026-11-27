# AGENTS.md — `@repopulse/deps-worker` (`apps/deps-worker`)

Guidance for coding agents working in the Dependencies BullMQ worker (`apps/deps-worker`, health port `3002`).

> **References:** [`docs/apps/deps-worker.md`](../../docs/apps/deps-worker.md) · [`docs/guides/dependencies.md`](../../docs/guides/dependencies.md) · [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md) · [`docs/packages/deps.md`](../../docs/packages/deps.md)

## 1. Non-Negotiable Invariants

- **No Untrusted Tool Execution:** Never invoke package managers, build backends, or repository scripts here; parse/rewrite text in `@repopulse/deps` and delegate lockfile regeneration to `deps-sandbox`. Always validate returned lockfiles via `validateLockfile`.
- **Per-Job Access & Ownership Checks:** Every `deps-update` job must re-verify `depsEnabled`, mode (`AUTO_PR` for auto jobs), `DependencyPrOwner`, App installation, and collaborator `write`+ permission. Fail closed on unreadable registry configs.
- **Branch Safety (`EDITED` vs Write Intent):** Never overwrite a bot branch whose head does not match `headSha`, except a persisted `DependencyBranchWriteIntent` SHA from an interrupted write.
- **Outbox & Redaction:** Persist `DependencyNotificationOutbox` intents in the same transaction that marks digest updates notified. Never expose `deps-sandbox` stderr in PR bodies, SSE events, or notifications (job logs only).
- **Boundaries & ESM:** Never import `apps/worker`. Exit with `SKIPPED`/`DISABLED` when `depsEnabled` is false. Use `.js` relative imports and rebuild `packages/*` before testing.

## 2. Commands

```sh
pnpm --filter @repopulse/deps-worker build
pnpm --filter @repopulse/deps-worker typecheck
pnpm --filter @repopulse/deps-worker lint
pnpm --filter @repopulse/deps-worker test
```
