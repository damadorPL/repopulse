# `@repopulse/notifications` (`packages/notifications`)

> **Summary:** channel metadata, release and dependency formatters, `dispatchNotification()`, `dispatchDependencyNotification()`, two-layer SSRF guard, HTTP sender, and Nodemailer SMTP transport. Users configure rules (channel + destination + optional tag scope + "only major" + events) in Settings → Notifications; `apps/worker` and `apps/deps-worker` dispatch deliveries, and `apps/web` runs Send Test.
>
> **Related Docs:** [../CONTRACTS.md](../CONTRACTS.md#custom-notification-webhook-payloads) · [../apps/worker.md](../apps/worker.md) · [../apps/deps-worker.md](../apps/deps-worker.md) · [../guides/recipes.md](../guides/recipes.md#add-a-notification-channel)

## Files (Cross-Package Map)

| Concern | File |
| --- | --- |
| Browser-safe channel metadata (labels, placeholders, hints, masking) | `packages/notifications/src/channels.ts` |
| Release & dependency dispatchers | `packages/notifications/src/{dispatcher,dependency-dispatcher}.ts` |
| Formatters (Discord, Slack, ntfy, Gotify, email, custom, dependencies) | `packages/notifications/src/formatters/{discord,slack,ntfy-gotify,email,custom,dependencies,markdown}.ts` |
| HTTP sender & two-layer SSRF guard | `packages/notifications/src/{http,ssrf-guard}.ts` |
| Worker rule matching (`ruleMatches`) & delivery | `apps/worker/src/processors/{fan-out.ts,notification.processor.ts}` |
| Dependency worker notification jobs & delivery | `apps/deps-worker/src/processors/{notify-jobs,deps-notify.processor}.ts` |
| Rule CRUD, events & Send Test | `apps/web/src/server/actions/notifications.ts`, `server/notification-destination.ts`, `lib/notification-events.ts`, `components/notifications/*` |
| SMTP settings (super admin) | `apps/web/src/server/actions/email-settings.ts`, `server/smtp-settings.ts`, `lib/smtp*.ts`, `components/email/smtp-settings-form.tsx`, `app/(dashboard)/admin/email/page.tsx`, `packages/db/src/instance-settings.ts` |

## Rules

- **MUST NOT** depend on `@repopulse/db`. Keep all inputs structural.
- **MUST NOT** import `node:*` or `nodemailer` from the browser-safe subpath `@repopulse/notifications/channels`.
- **MUST** validate new webhook destinations with `normalizeDestination` (which calls `validateWebhookUrl`) before storing them.
- **MUST** check `events` wherever a rule is matched: releases require `RELEASES`, dependency digests require `DEPENDENCY_UPDATES`, and PR notices require `DEPENDENCY_PULL_REQUESTS`. Tag-scoped rules may only have `RELEASES` (`validateEventsForScope`), and every rule needs ≥ 1 event.
- **MUST** pass `{ smtp }` to `dispatchNotification` / `dispatchDependencyNotification` for email rules (never read `SMTP_*` from env; there are no such variables).
- **MUST** display destinations only through `maskDestination` (webhook URLs carry secrets).
- **MUST** classify errors via `NotificationDeliveryError({ permanent: true })` for unrecoverable failures (4xx except 408/425/429, redirects, blocked URLs, missing SMTP, SMTP 5xx/auth). Everything else is transient.
- **MUST** use `.js` extensions on relative ESM imports and rebuild `packages/*` after edits.

## Channels

| Channel | Destination | Delivery |
| --- | --- | --- |
| `DISCORD_WEBHOOK` | webhook URL | JSON embed, colored by SemVer (`DISCORD_COLORS`) |
| `SLACK_WEBHOOK` | incoming webhook URL | Block Kit JSON |
| `NTFY_WEBHOOK` | topic URL | Markdown body; `Title`, `Priority` (`high` for MAJOR), tags, and click headers |
| `GOTIFY_WEBHOOK` | server URL with `?token=` | JSON message (priority 8 for MAJOR, else 5). Token moves to `X-Gotify-Key`; `/message` added if missing |
| `EMAIL_INSTANT` | optional recipient (empty = account email) | Nodemailer (`pool: true`, `TLSv1.2`), multipart text + inline-styled HTML |
| `CUSTOM_WEBHOOK` | any URL | JSON payload + `X-RepoPulse-Event` header ([../CONTRACTS.md](../CONTRACTS.md#custom-notification-webhook-payloads)) |
| `IN_APP` | none | Never dispatched: unread state + SSE are the in-app notification |
| `EMAIL_DIGEST` | none | Not built yet: no jobs queued |

## Lifecycle & Rule Events

1. **Release Fan-out (`planFanOut` in `apps/worker`):** for every subscriber receiving a release as unread, each enabled rule where `ruleMatches()` holds (`events` includes `RELEASES`, channel is deliverable, untagged or tag matches subscription, and `MAJOR` if `onlyMajorReleases`) queues `notify-{ruleId}-{releaseId}`.
2. **Release Job (`processNotification`):** re-checks rule (`EVENT_DISABLED` if `RELEASES` was removed), release, subscription, tag, snooze, and notification level. Permanent failures become `UnrecoverableError`.
3. **Rule Events:** `NotificationRule.events` defaults to `[RELEASES]`. Existing rules can be edited via `updateNotificationRuleEventsAction` (re-checks tag scope: tag-scoped rules reject dependency events with `TAG_SCOPED_EVENTS_MESSAGE`).
4. **Dependency Digests (`DEPENDENCY_UPDATES`):** `OUTDATED` rows with `notifiedAt = null` at or above `project.notificationLevel` (`passesDependencyNotificationLevel`) queue `deps-notify` via durable `DependencyNotificationOutbox` intents (max `DIGEST_MAX_ITEMS` = 25 items per digest, highest level first + "… and N more", link to `<APP_BASE_URL>/dependencies/<owner>/<name>`). First scan is silent unless `notifyOnFirstScan`.
5. **Dependency PR Notices (`DEPENDENCY_PULL_REQUESTS`):** `opened`, `updated` (commit with new versions), `edited` (external branch push), and `access_lost` (fallback to `NOTIFY`). Suppressed when `notificationLevel = NONE`.

## SSRF Guard

- `validateWebhookUrl(url, { policy, resolveAll })`: requires `http:` or `https:`, then classifies **every** resolved IPv4/IPv6 address:
  - `public`: allowed.
  - `internal` (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `::1`, `fc00::/7`): allowed only when `ALLOW_INTERNAL_WEBHOOK_HOSTS` matches (`true` = all, or comma-separated hostnames).
  - `forbidden` (`0/8`, `169.254/16` metadata, multicast, reserved, NAT64, 6to4, Teredo, TEST-NETs, `::`, `fe80::/10`, `ff00::/8`): never allowed.
- `createGuardedLookup(policy)` repeats the check inside the TCP socket's DNS lookup to prevent DNS rebinding.
- `postWebhook` disables keep-alive socket reuse (`agent: false`), uses a 10 s timeout, forbids redirects, and destroys oversized responses.
- Runs both at rule creation (`apps/web`) and at every delivery (`worker`, `deps-worker`, Send Test).
- SMTP hosts are **not** SSRF-checked (super-admin only; mail relays are commonly internal).

## SMTP Settings (Admin → Email) & Send Test

- Stored on `InstanceSettings`: `smtpHost` (`null` = off), `smtpPort` (default `587`), `smtpSecure` (`null` = auto: TLS on 465 else STARTTLS; `true` = implicit TLS; `false` = STARTTLS), `smtpUser`, `smtpPasswordEncrypted` (AES-256-GCM), `smtpFrom` (`null` → `defaultSmtpFrom(host, user)`).
- `saveSmtpSettingsAction` (super admin; Zod schema in `apps/web/src/lib/smtp-schema.ts`): empty `password` keeps the saved password; `clearPassword` or empty username drops it. `SmtpPasswordUnreadableError` produces a permanent failure telling the admin to re-enter the password.
- `sendSmtpTestEmailAction({ to? })` and `sendTestNotificationAction({ ruleId })` dispatch immediately (not queued) with a 10 s per-target cooldown.

## Public Exports (`packages/notifications/src/index.ts`)

| Export / Subpath | What |
| --- | --- |
| `@repopulse/notifications/channels` | Browser-safe `CHANNEL_INFO`, `DELIVERABLE_CHANNELS`, `isDeliverableChannel`, `channelLabel`, `maskDestination` |
| `dispatchNotification`, `dispatchDependencyNotification` | Release and dependency notification dispatchers (`NotificationDeliveryError`, `WebhookUrlError`, `isNotificationDeliveryError`) |
| `buildTestRelease`, `resolveAppBaseUrl`, `releaseReaderUrl` | Test payload and link builders (`APP_BASE_URL` → `AUTH_URL` → `NEXTAUTH_URL`) |
| `toSmtpConfig`, `defaultSmtpFrom`, `createSmtpSender`, `renderReleaseEmail`, `verifySmtpConfig`, `closeSmtpTransports`, `SMTP_NOT_CONFIGURED_MESSAGE` | Email formatting, pooled transport, verification, and shutdown cleanup |
| `format{Discord,Slack,CustomWebhook}Payload`, `build{Ntfy,Gotify}Request`, `formatGotifyMessage`, `resolveGotifyEndpoint` | Release channel formatters |
| `formatDependency*Payload`, `buildDependency*Request`, `renderDependencyEmail`, `buildDependencyContext`, `dependencyHeadline`, `dependencyLevelLabel`, `DIGEST_MAX_ITEMS` | Dependency channel formatters |
| `validateWebhookUrl`, `createGuardedLookup`, `classifyAddress`, `parseInternalHostsPolicy`, `internalHostsPolicyFromEnv`, `postWebhook` | Two-layer SSRF guard and HTTP webhook sender |
