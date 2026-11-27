# AGENTS.md — `@repopulse/notifications` (`packages/notifications`)

Guidance for coding agents working in notification channel formatters, dispatchers, SSRF guard, and SMTP transport (`packages/notifications`).

> **References:** [`docs/packages/notifications.md`](../../docs/packages/notifications.md) · [`docs/CONTRACTS.md`](../../docs/CONTRACTS.md#custom-notification-webhook-payloads)

## 1. Non-Negotiable Invariants

- **Zero DB Coupling & Browser-Safe Subpath:** Never import `@repopulse/db` (keep inputs structural). `@repopulse/notifications/channels` must never import `node:*` or `nodemailer`.
- **Two-Layer SSRF Guard & Transport:** All webhook deliveries go through `postWebhook` with `validateWebhookUrl`, `createGuardedLookup`, no redirects, and `agent: false`. Mask destinations via `maskDestination`.
- **SMTP & Error Classification:** Never read `SMTP_*` env vars (accept `{ smtp }` per dispatch). Classify unrecoverable failures (4xx except 408/425/429, blocked URLs, redirects, missing SMTP, SMTP 5xx/auth) as `NotificationDeliveryError({ permanent: true })`.
- **ESM & `dist/`:** Use `.js` extensions on relative imports in `src/` and rebuild `packages/*` after edits.

## 2. Commands

```sh
pnpm --filter @repopulse/notifications build
pnpm --filter @repopulse/notifications typecheck
pnpm --filter @repopulse/notifications lint
pnpm --filter @repopulse/notifications test
```
