# AGENTS.md — `@repopulse/deps-sandbox` (`apps/deps-sandbox`)

Guidance for coding agents working in the isolated lockfile-regeneration HTTP service (`apps/deps-sandbox`, port `3003`).

> **References:** [`docs/apps/deps-sandbox.md`](../../docs/apps/deps-sandbox.md) · [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md#sandbox-http-contract) · [`docs/operations/deployment.md`](../../docs/operations/deployment.md#dependencies-services-network-and-hardening)

## 1. Non-Negotiable Invariants

- **Secret & Environment Isolation:** Hold no secrets except `DEPS_SANDBOX_TOKEN` (constant-time SHA-256 bearer check, stripped from `process.env` at startup). Keep `docker-entrypoint.sh` `exec env -i` allowlisting intact and build child envs from scratch via `buildSandboxEnv`.
- **Registry & Tool Guards:** Refuse custom registries (`UNSUPPORTED_REGISTRY`) instead of stripping silently; delete risky config/env files before running tools; validate package names/versions before building `exec`/arg arrays; enforce pinned tool majors and lockfile format versions (`UNSUPPORTED_TOOL_VERSION`).
- **Execution & Concurrency:** Run package managers with scripts disabled and lockfile-only flags, process one `/v1/lock` job at a time (`503 BUSY`), kill the process group on timeout/abort, and conform to `@repopulse/deps/sandbox-contract`.
- **Network & ESM:** Production traffic exits only via `deps-egress` on `deps_sandbox` (`internal: true`). Use `.js` relative imports and rebuild `packages/*` before testing.

## 2. Commands

```sh
pnpm --filter @repopulse/deps-sandbox build
pnpm --filter @repopulse/deps-sandbox typecheck
pnpm --filter @repopulse/deps-sandbox lint
pnpm --filter @repopulse/deps-sandbox test
```
