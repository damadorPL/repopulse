# AGENTS.md — `@repopulse/github` (`packages/github`)

Guidance for coding agents working in the Octokit client, release/tag/commit polling, watched-path matching, GitHub App auth, and Git Data API package (`packages/github`).

> **References:** [`docs/packages/github.md`](../../docs/packages/github.md) · [`docs/guides/auth-and-access.md`](../../docs/guides/auth-and-access.md)

## 1. Non-Negotiable Invariants

- **Browser-Safe Subpath:** `@repopulse/github/watched-paths` (`paths.ts`) is imported by client code in `apps/web` and must never import `node:*` modules.
- **Credential & Token Safety:** Never include private keys, JWTs, or installation tokens in errors or logs (`GitHubAppAuthError`, `GitHubAppInstallationError`), and keep network/timeout errors distinct from invalid keys (`rethrowAppError`).
- **Least-Privilege App Access & Signatures:** Scope `createInstallationToken` to one repository and minimal permissions; verify webhook payloads with constant-time `verifyWebhookSignature`.
- **Rate Limits, ESM & `dist/`:** Map primary and secondary (`retry-after`) rate limits to `GitHubRateLimitError`. Use `.js` extensions on relative imports in `src/` and rebuild `packages/*` after edits.

## 2. Commands

```sh
pnpm --filter @repopulse/github build
pnpm --filter @repopulse/github typecheck
pnpm --filter @repopulse/github lint
pnpm --filter @repopulse/github test
```
