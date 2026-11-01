# Slice 05 — Implementation Summary

**Spec:** [`slice_05_notifications_self_hosted_webhooks.md`](./slice_05_notifications_self_hosted_webhooks.md)
**Status:** Implemented. Typecheck, 292 unit tests and all builds pass (19/19 turbo tasks). Every channel was delivered over real
sockets to local SMTP and HTTP receivers (see §5). The "Send Test" button was not clicked in a signed-in browser.
**Date:** 2026-11-01

---

## 1. Files

```text
packages/notifications/                       NEW @repopulse/notifications (ESM), used by worker and web
├── package.json                              nodemailer 10.1.2 (ships its own types)
└── src/
    ├── index.ts
    ├── types.ts                              structural rule/release/repository/user inputs (no @repopulse/db dependency)
    ├── errors.ts                             NotificationDeliveryError { permanent, status }, WebhookUrlError
    ├── ssrf-guard.ts                         validateWebhookUrl, classifyAddress, createGuardedLookup, ALLOW_INTERNAL_WEBHOOK_HOSTS
    ├── http.ts                               postWebhook: node:http(s), guarded DNS lookup, 10 s timeout, no redirects
    ├── markdown.ts                           cleanup, safe truncation (chars / UTF-8 bytes), Markdown → Slack mrkdwn / email HTML
    ├── channels.ts                           browser-safe channel metadata + maskDestination (exported as ./channels)
    ├── formatters/
    │   ├── discord.ts                        Rich Embed, semver colors, 3,800-char summary + RepoPulse link
    │   ├── slack.ts                          Block Kit: header, context, section, actions
    │   ├── ntfy-gotify.ts                    ntfy headers + Markdown body; Gotify JSON, token moved to X-Gotify-Key
    │   ├── email.ts                          SMTP config, pooled nodemailer transport, HTML + text template
    │   └── custom.ts                         generic JSON webhook payload
    ├── dispatcher.ts                         dispatchNotification(), buildTestRelease(), resolveAppBaseUrl()
    └── *.test.ts                             ssrf-guard, formatters, dispatcher (incl. a real local HTTP server)

apps/worker/src/
├── index.ts                                  passes BullMQ's abort signal to the notification processor
└── processors/
    ├── notification.processor.ts             replaces the Slice 04 stub
    ├── notification.processor.test.ts        NEW
    ├── fan-out.ts                            EMAIL_DIGEST rules no longer queue jobs
    └── fan-out.test.ts                       + acceptance case (Critical + major-only: v2.0.0 vs v2.0.1)

packages/queue/src/names.ts                   NOTIFICATION_JOB_OPTIONS: 3 attempts, exponential from 5 s

apps/web/src/
├── app/(dashboard)/settings/notifications/page.tsx      NEW settings page
├── server/actions/notifications.ts                      NEW create / toggle / delete / sendTest actions
├── server/notification-destination.ts (+ .test.ts)      NEW destination validation (not a "use server" module)
├── server/queries/notifications.ts                      NEW rule list with masked destinations
├── server/action-result.ts                              + DELIVERY_FAILED error code
├── components/notifications/                            NEW add-rule form, rule row, channel icons, Send Test toast helper
├── components/ui/switch.tsx                             NEW (radix-ui Switch)
├── components/ui/popover.tsx                            + PopoverClose
└── components/layout/app-sidebar.tsx, top-navbar.tsx    "Settings → Notifications" link; account menu link

scripts/sync-env.mjs, scripts/setup-env.mjs   SMTP_SECURE, SMTP_FROM, ALLOW_INTERNAL_WEBHOOK_HOSTS, APP_BASE_URL
docker-compose.coolify.yml                    web gets SMTP_*, ALLOW_INTERNAL_WEBHOOK_HOSTS, APP_BASE_URL; worker gets the new keys
README.md                                     notifications section
```

## 2. How it works

### SSRF guard
- `validateWebhookUrl(url)`:
  - requires `http:` or `https:`;
  - resolves the host with `dns.lookup({ all: true })`;
  - rejects the URL if **any** resolved address is blocked.
- Blocked by default: `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `::1` and `fc00::/7`.
  IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) are unwrapped before the check.
- **Always** blocked, even with the opt-in: `169.254.0.0/16` (cloud metadata), `fe80::/10`, `0.0.0.0/8`, `::`, multicast
  and reserved ranges.
- `ALLOW_INTERNAL_WEBHOOK_HOSTS` accepts:
  - `true` / `1`: every host may resolve to an internal address;
  - a comma-separated host list (`gotify,ntfy.lan`): only those hosts may.
- **DNS rebinding:** each delivery checks the URL again, then connects through a custom `lookup` that re-checks the address
  actually used for the socket. A host that resolves to a public address during validation and to a private one at connect
  time is refused (covered by a test).
- Redirects are not followed, since a 3xx could point at an internal address.

### Formatters
| Channel | Request |
| --- | --- |
| Discord | Embed: title `"{repo} {tag} released"`, `url` = GitHub release, color `0xEF4444` / `0x3B82F6` / `0x10B981` (plus amber for pre-releases, gray otherwise). The description holds up to 3,800 characters of notes plus a "Read in RepoPulse" link, so the total stays under 4,096. Version/type/tag fields. `allowed_mentions: { parse: [] }` stops release notes from pinging `@everyone`. |
| Slack | Block Kit `header` (repo + version), `context` (kind, title, tag), `section` (notes converted to mrkdwn, ≤ 2,900 chars), `actions` with "Open in RepoPulse" and "Release notes on GitHub" buttons, plus a fallback `text`. |
| ntfy | `POST` to the topic URL with headers `Title`, `Priority` (`high` for majors, else `default`), `Tags: package,rocket`, `Click` and `Markdown: yes`, plus an "Open in RepoPulse" action. Non-ASCII headers are RFC 2047 encoded. The body is cut below 3,800 bytes (ntfy turns bodies over 4 KiB into attachments). |
| Gotify | `{ title, message, priority: 8 or 5, extras: { client::display: text/markdown, client::notification.click } }`. `?token=` moves into the `X-Gotify-Key` header, and `/message` is appended when the URL only names the server. |
| Email | nodemailer SMTP transport from `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (+ optional `SMTP_SECURE`, `SMTP_FROM`). Pooled per config with 15 s timeouts. Multipart text + responsive HTML: repository, version badge, title, notes, "Open in RepoPulse" / GitHub buttons, and a footer link to the settings page. |
| Custom | JSON `{ event: "release.published", test, repository, release, rule, links }` with header `X-RepoPulse-Event`. |

Shared details:
- Release notes are cleaned first: HTML comments and tags are dropped, keeping their text.
- Truncation never splits a surrogate pair and prefers a word or line boundary.
- The email HTML is rendered by a small escape-first Markdown renderer, so notes can't inject markup, and only `http(s)` links
  become anchors.
- Links point back to RepoPulse at `{APP_BASE_URL}/?release={id}`, which opens the changelog drawer. `APP_BASE_URL` falls
  back to `AUTH_URL`, then `NEXTAUTH_URL`.

### Worker processor
1. Loads the rule (with its tag), the release (with its repository) and the user.
2. Skips with a logged reason when:
   - `RULE_GONE`: the rule was deleted or belongs to another user;
   - `RULE_DISABLED`;
   - `RELEASE_GONE`;
   - `NOT_MAJOR`: major-only rule, non-major release;
   - `UNSUPPORTED_CHANNEL`;
   - `UNSUBSCRIBED`: the user no longer tracks the repository;
   - `TAG_REMOVED`: the tag is no longer on the subscription.
3. Otherwise calls `dispatchNotification`.
4. Failures:
   - **Permanent** (4xx except 408/425/429, a redirect, a blocked URL, missing SMTP, SMTP 5xx/auth): throws BullMQ's
     `UnrecoverableError`, so the job fails without retrying.
   - **Transient** (timeouts, network errors, 429, 5xx): rethrown. `NOTIFICATION_JOB_OPTIONS` retries them: 3 attempts,
     exponential backoff from 5 s.

### Web
- **`createNotificationRuleAction`:**
  - checks that the tag belongs to the user;
  - caps rules at 25 per user;
  - validates the destination with the SSRF guard (Gotify also needs `?token=`);
  - email: refuses when the server has no `SMTP_HOST`; the recipient is optional (empty = account email).
- **`toggleNotificationRuleAction` / `deleteNotificationRuleAction`:** single statements scoped by `userId`.
- **`sendTestNotificationAction`:** delivers the synthetic `v1.0.0 - RepoPulse Test Release` (`MAJOR`) right away.
  - It ignores the rule's filters and works for paused rules too.
  - 10 s cooldown per rule.
  - Delivery errors come back as `DELIVERY_FAILED` with the service's message (e.g. "Discord rejected the notification:
    HTTP 404 (Unknown Webhook).").
- **The page** lists each rule with:
  - a channel icon and the masked destination;
  - its scope: an "All repositories" badge or the colored tag pill;
  - a "Major only" badge;
  - an enable switch (optimistic);
  - **Send Test** (loading → success/error toast);
  - Delete, with a confirmation dialog.
- **The add form** has channel and scope selects, a destination field whose label, placeholder and hint follow the channel,
  and a "Only major releases" checkbox. After creating a rule, the toast offers "Send test".
- **Destinations are never sent to the browser in full.** Webhook URLs carry secrets, so the page shows e.g.
  `discord.com/api/webhooks/123/abcd••••` or `gotify.example.com/message?••••`.

## 3. Deviations from the spec

| Spec | Implemented | Why |
| --- | --- | --- |
| Block `169.254.0.0/16` unless `ALLOW_INTERNAL_WEBHOOK_HOSTS=true` | Link-local / metadata / reserved ranges stay blocked even with the opt-in. `100.64.0.0/10` (CGNAT) is blocked by default too. | No self-hosted Gotify or ntfy lives on a metadata address. Tailscale-style CGNAT ranges are private networks. |
| `ALLOW_INTERNAL_WEBHOOK_HOSTS=true` | Also accepts a host list | Opens up one Gotify container without opening the whole Docker network. |
| — | Every delivery re-checks the address at connect time | Closes the DNS-rebinding gap between validation and connection. |
| — | Permanent failures skip the retries (`UnrecoverableError`) | Retrying a 404 webhook or a missing SMTP config cannot help. |
| — | Email rules take an optional recipient in `destinationUrl` | The column is the rule's destination for every channel. Empty = the account's email. |
| — | `EMAIL_DIGEST` and `IN_APP` are not offered in the form, and digest rules never queue jobs | Digests need a scheduler (not in this slice); in-app is always on. |
| — | New optional settings `SMTP_SECURE` and `SMTP_FROM`; `APP_BASE_URL` documented | Port 465 implicit TLS and a real sender address are needed by most providers. |

## 4. Known limitations

- **Webhook URLs are stored in plain text** (masked in the UI). Encrypting them with `TOKEN_ENCRYPTION_KEY` is possible
  later, but a key rotation would then break every rule.
- **There is no delivery history** (last sent, last error) on the rule. Failures only appear in the worker logs and in
  BullMQ's failed set (kept 7 days).
- **The "Send Test" cooldown is in-memory**, per web process.
- **Discord 429s** are retried by BullMQ's backoff (5 s, 10 s), not by Discord's `retry_after`.
- **The email body is cut at 8,000 characters.** Anything after that is only on the linked pages.

## 5. Verification

| Check | Result |
| --- | --- |
| `pnpm turbo run typecheck test build` | ✅ 19/19 tasks. Tests: notifications 73, worker 68 (+11), web 62 (+4), github 61, queue 20, db 8 |
| Spec §4.1 — `validateWebhookUrl` unit test | ✅ blocks `http://127.0.0.1:8080` and `http://169.254.169.254/latest/meta-data/`, allows Discord/Slack/ntfy/public-IP URLs |
| Spec §4.2 — Critical + major-only rule | ✅ unit tests: `planFanOut` queues the job for `v2.0.0` (MAJOR) and none for `v2.0.1` (PATCH); the processor dispatches `v2.0.0` and skips `v2.0.1` with `NOT_MAJOR` |
| Built worker loads the ESM package | ✅ `require()` of `dist/processors/notification.processor.js` (CJS) works on Node 26; real DNS check allowed `discord.com` and blocked the metadata IP |
| Real-socket delivery (scratch script, local sinks) | ✅ Email to a minimal SMTP server: multipart text + HTML, correct From/To/Subject. Discord (204), ntfy (Title/Priority headers, Markdown body) and Gotify (token in `X-Gotify-Key`) to a local HTTP server with `ALLOW_INTERNAL_WEBHOOK_HOSTS=localhost`. The same URL without the opt-in: "localhost (::1) is a private or loopback address…" |
| Email rendering | ✅ headless Chrome screenshot: badge, notes (lists, code, quote, links) and buttons render cleanly; the layout is fluid up to 600 px |
| `next dev` | ✅ `/settings/notifications` compiles; signed-out requests redirect (307) to `/login` |

**Not verified:**
- **Spec §4.3:** "Send Test" in a signed-in browser delivering to a real Discord/Slack/ntfy or SMTP inbox. The server action
  wraps the same `dispatchNotification` call that was verified above.
- **Spec §4.2 end to end:** a real poll ingesting a `v2.0.0` release through the running worker. The fan-out and processor are
  covered by unit tests only.
