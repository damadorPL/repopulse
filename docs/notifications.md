# Notifications

> **Summary:** users create rules (channel + destination + optional tag scope + "only major") in Settings →
> Notifications. The worker's `repo-poll` fan-out queues one `notification-dispatch` job per matching (rule,
> release), and the job calls `dispatchNotification()` from `@repopulse/notifications`. Email uses the SMTP server
> the **super admin** saved in Settings → Email. Webhooks pass a two-layer SSRF guard.

## Files

| Concern | File |
| --- | --- |
| Channel metadata (labels, placeholders, hints, masking) | `packages/notifications/src/channels.ts` |
| Dispatcher | `packages/notifications/src/dispatcher.ts` |
| Formatters | `packages/notifications/src/formatters/{discord,slack,ntfy-gotify,email,custom}.ts`, `markdown.ts` |
| HTTP sender | `packages/notifications/src/http.ts` |
| SSRF guard | `packages/notifications/src/ssrf-guard.ts` |
| Rule matching at fan-out | `apps/worker/src/processors/fan-out.ts` (`ruleMatches`) |
| Delivery job | `apps/worker/src/processors/notification.processor.ts` |
| Rule CRUD + Send Test | `apps/web/src/server/actions/notifications.ts`, `server/notification-destination.ts` |
| SMTP settings (super admin) | `apps/web/src/server/actions/email-settings.ts`, `server/smtp-settings.ts`, `lib/smtp.ts`, `components/email/smtp-settings-form.tsx`, `app/(dashboard)/settings/email/page.tsx`; loader `packages/db/src/instance-settings.ts` |

## Rules

- **MUST** validate new webhook destinations with `normalizeDestination` (it calls `validateWebhookUrl`) before
  storing them.
- **MUST** pass `{ smtp }` to `dispatchNotification` for email rules. The package does **not** read `SMTP_*` from the
  environment; there are no such variables.
- **MUST** show destinations only through `maskDestination` (webhook URLs carry secrets).
- **MUST** classify failures: `NotificationDeliveryError({ permanent: true })` for things a retry can't fix (4xx
  except 408/425/429, redirects, blocked URLs, missing SMTP, SMTP 5xx/auth). Everything else is transient.
- A new channel needs: an enum value (migration), `DELIVERABLE_CHANNELS` + `CHANNEL_INFO`, a formatter, a `switch`
  case in `dispatchNotification`, an icon in `components/notifications/channel-icon.tsx`, and tests
  ([recipes.md](./recipes.md#add-a-notification-channel)).

## Channels

| Channel | Destination | Delivery |
| --- | --- | --- |
| `DISCORD_WEBHOOK` | webhook URL | JSON embed, colored by SemVer (`DISCORD_COLORS`) |
| `SLACK_WEBHOOK` | incoming webhook URL | Block Kit JSON |
| `NTFY_WEBHOOK` | topic URL | Markdown body; `Title`, `Priority` (`high` for MAJOR), tags and click headers |
| `GOTIFY_WEBHOOK` | server URL with `?token=` | JSON message (priority 8 for MAJOR, else 5). The token moves to the `X-Gotify-Key` header; `/message` is added if missing |
| `EMAIL_INSTANT` | optional recipient (empty = the account email) | nodemailer, multipart text + inline-styled HTML |
| `CUSTOM_WEBHOOK` | any URL | JSON `{ event: "release.published", test, repository, release, links }`, header `X-RepoPulse-Event` |
| `IN_APP` | none | Never dispatched: the unread state and SSE are the in-app notification |
| `EMAIL_DIGEST` | none | Not built yet: no jobs are queued |

## Lifecycle of a notification

1. **Fan-out** (`planFanOut` in repo-poll): for every subscriber that got the release as unread, each enabled rule
   where `ruleMatches()` holds becomes a job `notify-{ruleId}-{releaseId}`. It holds when: the channel is not
   `IN_APP`/`EMAIL_DIGEST`; the rule has no tag, or its tag is assigned to the subscription; and, for major-only
   rules, the release is `MAJOR`.
2. **Job** (`processNotification`): re-check the rule, release, subscription and tag. If anything changed, the job is
   `SKIPPED` with a reason.
3. **Dispatch**: format → send. Webhooks: `postWebhook` with the guarded DNS lookup, a 10 s timeout, and no redirects.
   Email: `createSmtpSender(config)` (transport cached per config; stale transports are closed on change).
4. **Retry policy**: 3 attempts, exponential from 5 s. Permanent → `UnrecoverableError`.

## SSRF guard

- `validateWebhookUrl(url, { policy, resolveAll })`: http(s) only, then **every** resolved address is classified:
  - `public`: allowed;
  - `internal` (127/8, 10/8, 172.16/12, 192.168/16, 100.64/10, ::1, fc00::/7): only with
    `ALLOW_INTERNAL_WEBHOOK_HOSTS` (`true` = all, or a comma list of hostnames);
  - `forbidden` (0/8, 169.254/16 metadata, multicast, reserved, ::, fe80::/10, ff00::/8): never allowed.
- `createGuardedLookup(policy)` repeats the check inside the socket's DNS lookup, so the address actually connected to
  is the one that was checked (no DNS rebinding).
- Runs at rule creation (web) **and** on every delivery (worker and Send Test).
- The SMTP host is **not** SSRF-checked: only the super admin can set it, and relays are often internal.

## SMTP settings (Settings → Email)

- Stored on `InstanceSettings`: `smtpHost` (null = email off), `smtpPort` (default 587), `smtpSecure` (`null` = auto:
  TLS on 465, otherwise STARTTLS when offered; `true` = implicit TLS; `false` = STARTTLS), `smtpUser`,
  `smtpPasswordEncrypted` (AES-GCM), `smtpFrom` (null → `defaultSmtpFrom(host, user)`).
- `saveSmtpSettingsAction` (super admin): zod `smtpSettingsInput` (`lib/smtp.ts`): host without scheme or port,
  port 1–65535, `security` `auto|tls|starttls`, sender `addr` or `Name <addr>`. An empty `password` keeps the saved
  one; `clearPassword` or an empty username drops it. Returns `SmtpSettingsView`, which never includes the password.
- `removeSmtpSettingsAction`: clears every SMTP column. Email rules stay but fail permanently until SMTP is set again.
- `sendSmtpTestEmailAction({ to? })`: sends the test release through the **saved** settings to `to` or the admin's
  email. 10 s cooldown.
- Reading: web `getSmtpConfig()` / `isSmtpConfigured()`; worker `toSmtpConfig(await loadSmtpSettings(prisma))` per
  job. If decryption fails (`TOKEN_ENCRYPTION_KEY` changed), `SmtpPasswordUnreadableError` → a permanent failure whose
  message says to re-enter the password.
- UI: the Email channel in the rule form is disabled while `isSmtpConfigured()` is false. The super admin gets a link
  to `/settings/email`; other members are told to ask the super admin.

## Send Test

`sendTestNotificationAction({ ruleId })` dispatches `buildTestRelease()` right away (not through the queue),
ignoring the rule's filters, with a 10 s cooldown per rule. It returns `DELIVERY_FAILED` with the service's message on
failure. The client helper is `components/notifications/send-test.ts` (one toast: loading → success or error).
