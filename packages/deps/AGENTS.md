# AGENTS.md — `@repopulse/deps` (`packages/deps`)

Guidance for coding agents working in the pure-TypeScript dependency parsing, registry, planning, rewrite, and sandbox-contract library (`packages/deps`).

> **References:** [`docs/packages/deps.md`](../../docs/packages/deps.md) · [`docs/guides/dependencies.md`](../../docs/guides/dependencies.md) · [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md)

## 1. Non-Negotiable Invariants

- **Zero DB/Octokit Coupling:** Never depend on `@repopulse/db` or Octokit; keep all inputs structural and inject `fetch` / registry caches.
- **Browser-Safe Subpaths:** `@repopulse/deps/limits` and `@repopulse/deps/sandbox-contract` are imported by `apps/web` and must never import `node:*` modules.
- **Fixed Registries & Safe Rewrites:** Registry clients must target fixed public registry hosts only (no user-supplied URLs). Manifest rewrites use JS string-offset spans and must pass structural re-parse verification (`ManifestRewriteError`).
- **ESM & `dist/`:** Use `.js` extensions on relative imports in `src/` and rebuild `packages/*` after edits so apps/tests pick up changes.

## 2. Commands

```sh
pnpm --filter @repopulse/deps build
pnpm --filter @repopulse/deps typecheck
pnpm --filter @repopulse/deps lint
pnpm --filter @repopulse/deps test
```
