# Agent Implementation Slice 05: Multi-Channel Notifications (SMTP, Slack, Discord, Ntfy, Gotify) & Routing Rules UI

## 1. Objective & Scope
Build the `@repopulse/notifications` package and wire it into `apps/worker` and `apps/web`. Users can create granular notification rules scoped to specific Tags (or all repositories), filter by Major-only releases, test their channels, and receive formatted alerts via Email (`nodemailer` SMTP), Slack, Discord, Ntfy.sh, Gotify, or custom JSON webhooks—complete with SSRF protection for Coolify self-hosted environments.

* **Prerequisites:** Slices 01–04 completed.

---

## 2. Target Files to Create / Modify
```text
repopulse/
├── packages/
│   └── notifications/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── ssrf-guard.ts          # Blocks private/loopback IPs on webhook URLs
│           ├── formatters/
│           │   ├── slack.ts           # Slack Block Kit formatter
│           │   ├── discord.ts         # Discord Rich Embed formatter (4096-char safe truncation)
│           │   ├── ntfy-gotify.ts     # Self-hosted Ntfy & Gotify push formatters
│           │   └── email.ts           # HTML + plaintext email template & Nodemailer transport
│           └── dispatcher.ts          # Unified dispatchNotification()
├── apps/
│   ├── worker/
│   │   └── src/processors/
│   │       └── notification.processor.ts
│   └── web/
│       └── src/
│           ├── server/actions/
│           │   └── notifications.ts   # CRUD for NotificationRule + sendTestNotificationAction
│           └── app/(dashboard)/settings/notifications/
│               └── page.tsx           # Notification Rules configuration & "Send Test" UI
```

---

## 3. Step-by-Step Agent Instructions

### Step 3.1: SSRF Protection Guard (`packages/notifications/src/ssrf-guard.ts`)
1. Implement `validateWebhookUrl(urlString: string): Promise<URL>`:
   * Parse URL and enforce `protocol === 'https:' || protocol === 'http:'`.
   * Resolve hostname via `node:dns/promises` (`lookup(hostname, { all: true })`).
   * Block loopback, link-local, and internal Docker/cloud metadata IP ranges:
     * `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`.
   * Allow an optional override env var `ALLOW_INTERNAL_WEBHOOK_HOSTS=true` for users who explicitly run Gotify/Ntfy on the same private network and opt in.

### Step 3.2: Channel Payload Formatters (`packages/notifications/src/formatters/*`)
1. **Discord (`discord.ts`)**:
   * Format an Embed object with `title: "${repo.fullName} ${release.tagName} released"`, `url: release.htmlUrl`, color based on `semverType` (`0xEF4444` for `MAJOR`, `0x3B82F6` for `MINOR`, `0x10B981` for `PATCH`), and `description` truncated safely at 3,800 characters with a link back to the RepoPulse dashboard reader.
2. **Slack (`slack.ts`)**:
   * Format Slack Block Kit payload (`header` block with repo & version, `section` block with summary markdown, and `actions` button linking to RepoPulse and GitHub release notes).
3. **Ntfy & Gotify (`ntfy-gotify.ts`)**:
   * **Ntfy:** Send HTTP `POST` to `destinationUrl` with headers `Title: New Release: ${repo.fullName} ${release.tagName}`, `Priority: ${release.semverType === 'MAJOR' ? 'high' : 'default'}`, `Tags: package,rocket`, `Click: ${release.htmlUrl}`, and Markdown body.
   * **Gotify:** Send JSON `{ title, message, priority: release.semverType === 'MAJOR' ? 8 : 5, extras: { 'client::display': { contentType: 'text/markdown' } } }`.
4. **SMTP Email (`email.ts`)**:
   * Use `nodemailer.createTransport` configured with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`.
   * Render a clean responsive HTML email showing the repository name, version badge, changelog summary, and a direct button to open the release in RepoPulse.

### Step 3.3: Worker Notification Processor (`apps/worker/src/processors/notification.processor.ts`)
1. Receive job `{ ruleId, releaseId, userId }` from the `notification-dispatch` BullMQ queue.
2. Fetch `NotificationRule`, `Release`, `Repository`, and `User`.
3. Verify `rule.enabled === true`. If `rule.onlyMajorReleases === true` and `release.semverType !== 'MAJOR'`, skip gracefully.
4. Call `dispatchNotification({ rule, release, repository, user })` from `@repopulse/notifications`.
5. Configure BullMQ retry policy (`attempts: 3`, exponential backoff starting at `5000ms`) so transient webhook timeouts are retried automatically.

### Step 3.4: Notification Rules UI & Test Action (`apps/web`)
1. **`apps/web/src/server/actions/notifications.ts`**:
   * `createNotificationRuleAction({ tagId, channel, destinationUrl, onlyMajorReleases })`
   * `toggleNotificationRuleAction({ ruleId, enabled })`
   * `deleteNotificationRuleAction({ ruleId })`
   * `sendTestNotificationAction({ ruleId })`: Invokes `dispatchNotification` synchronously with a synthetic sample release (`v1.0.0 - RepoPulse Test Release`) so the user can immediately verify their Discord/Slack/Ntfy/SMTP configuration in the UI.
2. **`apps/web/src/app/(dashboard)/settings/notifications/page.tsx`**:
   * List existing notification rules showing Target Scope (`All Repositories` or a colored `Tag` badge), Channel icon, Major-only badge, Enable/Disable switch, **"Send Test"** button, and Delete button.
   * Provide an **"Add Notification Rule"** form supporting channel selection and contextual placeholder hints for Webhook URLs.

---

## 4. Verification & Acceptance Criteria
- [ ] Unit test on `validateWebhookUrl` blocks `http://127.0.0.1:8080` and `http://169.254.169.254/latest/meta-data/` while allowing valid public webhook URLs.
- [ ] Creating a rule for tag `Critical` with `onlyMajorReleases: true` dispatches a webhook when a `v2.0.0` (`MAJOR`) release is ingested, and skips when `v2.0.1` (`PATCH`) is ingested.
- [ ] Clicking **"Send Test"** in the Notification Settings UI delivers a test message to the configured webhook or SMTP inbox and returns a success toast in the panel.