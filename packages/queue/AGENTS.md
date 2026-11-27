# AGENTS.md — `@repopulse/queue` (`packages/queue`)

Guidance for coding agents working in BullMQ queue definitions, deduplication helpers, Redis/SSE contracts, health server, and Pino logger (`packages/queue`).

> **References:** [`docs/packages/queue.md`](../../docs/packages/queue.md) · [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md)

## 1. Non-Negotiable Invariants

- **Browser-Safe SSE Contract:** `@repopulse/queue/events` (`events.ts`) must never import `node:*`, `ioredis`, or `bullmq`. When changing `RealtimeEvent`, update `parseRealtimeEvent`, `events.test.ts`, worker publishers, and `SseListener`.
- **BullMQ ID & Priority Rules:** Never put `:` in jobIds or deduplication ids (use `-`). Keep shared job options and explicit priorities aligned across `apps/web`, `apps/worker`, and `apps/deps-worker`.
- **Health & Logging Hygiene:** Keep health check JSON responses free of connection strings, credentials, or raw driver errors.
- **ESM & `dist/`:** Use `.js` extensions on relative imports in `src/` and rebuild `packages/*` after edits.

## 2. Commands

```sh
pnpm --filter @repopulse/queue build
pnpm --filter @repopulse/queue typecheck
pnpm --filter @repopulse/queue lint
pnpm --filter @repopulse/queue test
```
