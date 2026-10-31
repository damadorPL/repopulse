# Product Requirements Document (PRD): RepoPulse — GitHub Release & Changelog Tracker (Coolify Monorepo Edition)

**Document Version:** 2.0 (Unified Product & Coolify Architecture Specification)  
**Deployment Target:** Coolify v4+ (Self-Hosted PaaS via Docker Compose / Multi-Stage Builds)  
**Tech Stack:** Full-Stack TypeScript 5.x, Turborepo + `pnpm` Workspaces, Next.js (App Router), Node.js + BullMQ, PostgreSQL, Redis  
**Status:** Ready for Engineering & Deployment

---

## 1. Executive Summary & Product Vision

Developers, DevOps engineers, and engineering teams depend on dozens of open-source libraries, tools, and internal repositories, making it difficult to keep up with breaking changes, security patches, and new releases. **RepoPulse** is a self-hostable, TypeScript-based web application that allows authenticated users to track GitHub repositories, automatically polls for new releases and changelog updates on a scheduled basis, organizes tracked repositories using custom tags/categories, and delivers configurable notifications when updates occur.

### 1.1 Target Audience
* **Software Engineers & Tech Leads:** Tracking dependencies, frameworks, and tools for breaking changes or major releases.
* **DevOps & Self-Hosting Enthusiasts:** Monitoring upstream infrastructure tools, Docker apps, and security patches on their own Coolify instance.
* **Open-Source Curators:** Keeping a categorized, searchable feed of favorite projects organized by topic.

### 1.2 Why Coolify + Turborepo Monorepo?
Deploying a background-heavy application (cron polling + queues + real-time web UI) on serverless platforms often introduces cold-start timeouts and high queue pricing. Targeting **Coolify** unlocks persistent, long-running Node.js processes and co-located PostgreSQL and Redis instances on an internal Docker network with zero bandwidth fees.

Structuring the project as a **Turborepo + `pnpm` workspace monorepo** allows the **User-Facing Web App** (`apps/web`) and the **Persistent Background Worker** (`apps/worker`) to share the exact same database schema (`packages/db`), GitHub API/ETag logic (`packages/github`), and notification formatters (`packages/notifications`) with end-to-end TypeScript safety and independent container scaling.

---

## 2. User Roles & Core User Stories

| Role | User Story | Acceptance Criteria |
| :--- | :--- | :--- |
| **Authenticated User** | As a user, I want to sign in with my GitHub account so I can quickly authenticate and unlock higher GitHub API rate limits (5,000 req/hr). | OAuth2 login flow via GitHub completes in under 3 clicks; user session and AES-256-GCM encrypted OAuth token are stored securely. |
| **Authenticated User** | As a user, I want to add a GitHub repository via URL or `owner/repo` string so I can start tracking its releases immediately. | Input validates repo existence via GitHub API, fetches initial metadata and the latest 10 releases synchronously, and displays them in the panel. |
| **Authenticated User** | As a user, I want to assign custom tags and categories to my tracked repos so I can filter my feed (e.g., `Frontend`, `Self-Hosted`, `Critical`). | Users can create color-coded tags, assign multiple tags per repo, and filter the main release feed and repository list by tag. |
| **Authenticated User** | As a user, I want the system to periodically check my repos for new releases or tags in the background so I don't have to check manually. | BullMQ worker runs every $N$ minutes, detects new releases/tags using conditional `ETag` headers, stores Markdown changelogs, and marks them as "Unread". |
| **Authenticated User** | As a user, I want to receive real-time in-app and external notifications when a tracked repo publishes a new release. | Users receive live SSE unread badge updates in the UI and optional Email (SMTP/Resend) or Webhook (Slack, Discord, Ntfy, Gotify) alerts based on per-tag rules. |

---

## 3. Functional Requirements

### 3.1 Authentication & User Management
* **GitHub OAuth Integration:** Primary sign-in via GitHub OAuth (Auth.js / NextAuth). Requests `read:user` and `user:email` scopes (plus optional `repo` scope if the user wants to track private repositories).
* **Token Encryption:** User GitHub OAuth tokens are encrypted at rest in PostgreSQL using `AES-256-GCM` so `apps/worker` can use them for authenticated polling without exposing plaintext tokens in database backups.
* **User Preferences:** Global polling frequency defaults, timezone configuration, and notification channel testing.

### 3.2 Repository Management
* **Add Repository:**
  * Accept full URL (`https://github.com/coollabsio/coolify`) or shorthand (`coollabsio/coolify`).
  * Auto-validate repository visibility and existence via GitHub REST/GraphQL API.
  * Initial ingestion fetches repository metadata (`githubRepoId`, description, stars, primary language, owner avatar, default branch) and the 10 most recent releases/tags.
* **Tracking Mode Configuration:**
  * **Releases Only (Default):** Tracks formal GitHub Releases (`GET /repos/{owner}/{repo}/releases`).
  * **Tags Fallback:** For repositories that only push Git tags without formal GitHub Releases, parse tags and compare commit logs or `CHANGELOG.md`.
  * **Pre-release Toggle:** Per-subscription toggle to ignore or include `prerelease` / `alpha` / `beta` / `rc` versions.

### 3.3 Periodic Sync & Changelog Ingestion Engine
* **Deduplicated Global Polling:** If 50 users on the instance track `vercel/next.js`, the worker polls `vercel/next.js` **once** per interval and fans out the newly discovered release to all 50 subscribed users.
* **ETag & Conditional Requests:** Store the `ETag` header from GitHub API responses on each `Repository` record. Send `If-None-Match` headers on subsequent checks; `304 Not Modified` responses consume **zero** GitHub API rate-limit quota.
* **Changelog Parsing & Storage:**
  * Store raw Markdown (`bodyMarkdown`) and sanitize/compile it for safe HTML rendering in the dashboard.
  * Extract semantic version (`semver`) breakdown (`MAJOR`, `MINOR`, `PATCH`, `PRERELEASE`) to highlight breaking changes.
* **Manual Sync:** Provide a "Sync Now" button in the UI panel with a 5-minute cooldown per repository that enqueues a high-priority BullMQ job.

### 3.4 Tags, Categories & Filtering
* **Custom Categories/Tags:** Users can create, rename, color-code, and delete custom tags (e.g., `Production Deps`, `Coolify Stack`, `UI Libraries`).
* **Multi-Tag Assignment:** Many-to-many relationship allowing a single tracked repository to belong to multiple tags.
* **Dashboard Filtering & Sorting:**
  * Filter feed by: Tag/Category, Read/Unread status, Release Severity (`MAJOR`, `MINOR`, `PATCH`), or specific Repository.
  * Sort by: Release published date (newest/oldest), Repository name, or Star count.
  * Search bar: Full-text search across repository names, tag names, and release changelog bodies.

### 3.5 Panel UI & Changelog Viewer
* **Unified Activity Feed:** Chronological timeline of releases across all tracked repositories, featuring SemVer severity badges, release timestamps, repository avatars, and assigned tags.
* **Split-Pane / Slide-Over Changelog Reader:** Clicking a release opens a clean Markdown reader displaying full release notes, syntax-highlighted code blocks, GitHub asset/tarball links, author info, and a direct link to the GitHub compare diff.
* **Real-Time Updates (Redis Pub/Sub + SSE):** When `apps/worker` discovers a new release or completes a manual sync, it publishes an event to Redis (`user:{userId}:events`). `apps/web` streams this via Server-Sent Events (`/api/events/stream`) to update unread badges and the release feed live without page reloads.

### 3.6 Notification System (Self-Hosted & Cloud Friendly)
* **In-App Notifications:** Live notification center in the top bar showing unread release counts, grouped by repository or tag.
* **External Channels:**
  * **Email:** Supports both standard self-hosted `SMTP` (`nodemailer`) and API providers (`Resend`) for instant alerts or Daily/Weekly Digests.
  * **Chat & Push Webhooks:** Native payload formatters for **Slack** (Block Kit), **Discord** (Rich Embeds), **Ntfy.sh**, **Gotify**, and generic JSON POST webhooks.
* **Granular Routing Rules:** Users can configure rules such as: *"Send Discord + Ntfy notification for `Critical` tag on any release, but only send Weekly Email Digest for `Inspiration` tag."*

---

## 4. Monorepo Architecture & Directory Structure

```text
repopulse/
├── apps/
│   ├── web/                        # Next.js (App Router, Auth.js, tRPC/Server Actions, Dashboard UI)
│   │   ├── Dockerfile              # Multi-stage Next.js standalone image using turbo prune
│   │   ├── src/
│   │   │   ├── app/                # UI routes, slide-over changelog viewer, SSE endpoint, /api/health
│   │   │   ├── components/         # Tailwind + shadcn/ui panel components
│   │   │   └── server/             # tRPC routers / Server Actions
│   │   └── package.json
│   └── worker/                     # Long-running Node.js + BullMQ Scheduler & Processor
│       ├── Dockerfile              # Multi-stage Node.js runner & DB migrator image
│       ├── src/
│       │   ├── index.ts            # Worker entrypoint + graceful SIGTERM handler
│       │   ├── queues/             # repo-poll.queue.ts, notification.queue.ts
│       │   ├── processors/         # github-fetcher.ts, notifier.ts
│       │   └── health.ts           # Lightweight HTTP :3001/health endpoint for Coolify healthchecks
│       └── package.json
├── packages/
│   ├── db/                         # Prisma or Drizzle ORM schema, migrations, and typed client
│   │   ├── prisma/schema.prisma
│   │   ├── src/crypto.ts           # AES-256-GCM token encryption/decryption helper
│   │   ├── src/index.ts
│   │   └── package.json
│   ├── github/                     # Shared Octokit wrapper, ETag caching, SemVer & Markdown parser
│   │   ├── src/index.ts
│   │   └── package.json
│   ├── notifications/              # Shared SMTP/Resend, Slack, Discord, Ntfy, and Gotify dispatchers
│   │   ├── src/index.ts
│   │   └── package.json
│   └── tsconfig/                   # Shared base TypeScript configurations
├── docker-compose.coolify.yml      # Production Docker Compose stack for Coolify
├── turbo.json                      # Turborepo pipeline configuration
├── pnpm-workspace.yaml             # Workspace package definitions
└── package.json
```

### 4.1 Shared Package Responsibilities (`packages/*`)
* **`@repopulse/db`:** Exports the singleton database client (`db`), all TypeScript models, and `crypto.ts` (`encryptToken` / `decryptToken` using `TOKEN_ENCRYPTION_KEY`).
* **`@repopulse/github`:**
  * `validateAndFetchRepo(owner, repo, token)`: Used by `apps/web` when a user adds a repo in the UI to synchronously validate and populate initial releases.
  * `pollRepoReleases(repoRecord, token)`: Used by `apps/worker`. Sends `If-None-Match: repoRecord.lastEtag`, classifies SemVer (`MAJOR` / `MINOR` / `PATCH`), and returns `{ status: 'NOT_MODIFIED' | 'UPDATED', etag, newReleases }`.
* **`@repopulse/notifications`:** Unified `dispatchNotification(rule, release, repo, user)` function that formats Markdown changelogs into Slack Block Kit, Discord Embeds (safely truncated at 4,096 chars), Ntfy/Gotify payloads, or HTML emails.

---

## 5. Data Model & TypeScript Schema Specification

```typescript
// Core TypeScript Domain Models (packages/db)

export interface User {
  id: string;
  email: string;
  name: string | null;
  githubId: string;
  githubAccessTokenEncrypted: string | null; // AES-256-GCM encrypted
  createdAt: Date;
}

export interface Repository {
  id: string;
  githubRepoId: number;       // Immutable GitHub ID (survives owner/repo renames)
  owner: string;              // e.g., "coollabsio"
  name: string;               // e.g., "coolify"
  fullName: string;           // e.g., "coollabsio/coolify"
  description: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
  starsCount: number;
  lastPolledAt: Date | null;
  lastEtag: string | null;    // Used for 304 Not Modified conditional requests
  pollStatus: 'IDLE' | 'POLLING' | 'ERROR';
  errorCount: number;
}

export interface Release {
  id: string;
  repositoryId: string;
  githubReleaseId: number;
  tagName: string;            // e.g., "v4.0.0-beta.380"
  title: string;
  bodyMarkdown: string;       // Raw changelog markdown
  htmlUrl: string;
  isPrerelease: boolean;
  isDraft: boolean;
  semverType: 'MAJOR' | 'MINOR' | 'PATCH' | 'PRERELEASE' | 'OTHER';
  publishedAt: Date;
  discoveredAt: Date;
}

export interface UserSubscription {
  id: string;
  userId: string;
  repositoryId: string;
  includePrereleases: boolean;
  trackMode: 'RELEASES' | 'TAGS_AND_COMMITS';
  createdAt: Date;
}

export interface Tag {
  id: string;
  userId: string;
  name: string;               // e.g., "Self-Hosted"
  slug: string;               // e.g., "self-hosted"
  colorHex: string;           // e.g., "#8B5CF6"
}

export interface SubscriptionTag {
  subscriptionId: string;
  tagId: string;
}

export interface UserReleaseState {
  userId: string;
  releaseId: string;
  isRead: boolean;
  readAt: Date | null;
}

export interface NotificationRule {
  id: string;
  userId: string;
  tagId: string | null;       // Null = applies to all tracked repos
  channel:
    | 'IN_APP'
    | 'EMAIL_INSTANT'
    | 'EMAIL_DIGEST'
    | 'DISCORD_WEBHOOK'
    | 'SLACK_WEBHOOK'
    | 'NTFY_WEBHOOK'
    | 'GOTIFY_WEBHOOK'
    | 'CUSTOM_WEBHOOK';
  destinationUrl: string | null;
  onlyMajorReleases: boolean;
  enabled: boolean;
}
```

---

## 6. Coolify Deployment & Infrastructure Specification

RepoPulse is designed to deploy on **Coolify** using the **Docker Compose Build Pack** so the entire stack (Web UI, Background Worker, Database Migrator, PostgreSQL, and Redis) deploys atomically from a single Git repository.

### 6.1 Coolify Service Topology

| Service Name | Workspace Path | Port | Coolify Role | Healthcheck |
| :--- | :--- | :--- | :--- | :--- |
| **`web`** | `apps/web` | `3000` (HTTPS via Coolify Proxy) | Public Next.js Frontend, Auth, & API | `GET /api/health` (`200 OK`) |
| **`worker`** | `apps/worker` | `3001` (Internal only) | BullMQ Cron Scheduler, GitHub Poller, Notification Dispatcher | `GET http://localhost:3001/health` (verifies Redis + DB connection) |
| **`migrator`** | `packages/db` | None (One-off init container) | Runs `db:migrate:deploy` before `web` and `worker` start | Exit code `0` |
| **`postgres`** | `postgres:16-alpine` | `5432` (Internal) | Primary relational storage + persistent volume | `pg_isready` |
| **`redis`** | `redis:7-alpine` | `6379` (Internal) | BullMQ job store & SSE Pub/Sub (`noeviction` policy) | `redis-cli ping` |

### 6.2 Production `docker-compose.coolify.yml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-repopulse}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB:-repopulse}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-repopulse}"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    # CRITICAL: maxmemory-policy noeviction is required for BullMQ stability
    command: redis-server --appendonly yes --maxmemory-policy noeviction --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  migrator:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
      target: migrator
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-repopulse}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-repopulse}
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER:-repopulse}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-repopulse}
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
      AUTH_SECRET: ${AUTH_SECRET}
      AUTH_GITHUB_ID: ${AUTH_GITHUB_ID}
      AUTH_GITHUB_SECRET: ${AUTH_GITHUB_SECRET}
      TOKEN_ENCRYPTION_KEY: ${TOKEN_ENCRYPTION_KEY}
      # Coolify automatically injects SERVICE_FQDN_WEB for domain routing
      NEXTAUTH_URL: ${SERVICE_FQDN_WEB}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrator:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/api/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3

  worker:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
      target: runner
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER:-repopulse}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-repopulse}
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
      TOKEN_ENCRYPTION_KEY: ${TOKEN_ENCRYPTION_KEY}
      POLL_INTERVAL_CRON: ${POLL_INTERVAL_CRON:-*/30 * * * *}
      SMTP_HOST: ${SMTP_HOST}
      SMTP_PORT: ${SMTP_PORT}
      SMTP_USER: ${SMTP_USER}
      SMTP_PASS: ${SMTP_PASS}
      APP_BASE_URL: ${SERVICE_FQDN_WEB}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrator:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3001/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3

volumes:
  postgres_data:
  redis_data:
```

### 6.3 Coolify Build & Runtime Requirements
1. **Docker Layer Caching via `turbo prune`:** Both `apps/web/Dockerfile` and `apps/worker/Dockerfile` must use multi-stage builds with `turbo prune @repopulse/web --docker` and `turbo prune @repopulse/worker --docker` so UI-only changes do not trigger worker rebuilds in Coolify.
2. **Graceful `SIGTERM` Worker Shutdown:** When Coolify rolls out a new deployment, `apps/worker/src/index.ts` traps `SIGTERM`, calls `await worker.close()` on BullMQ workers to finish in-flight GitHub fetches, closes database connections, and exits cleanly.

### 6.4 Coolify Environment Variables Checklist

| Variable | Scope | Description |
| :--- | :--- | :--- |
| `POSTGRES_USER` | Shared | Database user (default: `repopulse`) |
| `POSTGRES_PASSWORD` | Shared | Strong auto-generated password in Coolify |
| `POSTGRES_DB` | Shared | Database name (default: `repopulse`) |
| `REDIS_PASSWORD` | Shared | Strong auto-generated password for Redis |
| `AUTH_SECRET` | `web` | 32-byte hex secret (`openssl rand -hex 32`) for Auth.js sessions |
| `AUTH_GITHUB_ID` | `web` | GitHub OAuth App Client ID |
| `AUTH_GITHUB_SECRET` | `web` | GitHub OAuth App Client Secret |
| `TOKEN_ENCRYPTION_KEY` | `web`, `worker` | 64-character hex string (32 bytes) for AES-256-GCM encryption of OAuth tokens |
| `POLL_INTERVAL_CRON` | `worker` | Default cron schedule for repo checks (default: `*/30 * * * *`) |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | `worker` | Optional SMTP credentials for email alerts |

---

## 7. Security, Rate Limiting & Edge Cases

* **GitHub Rate-Limit Resilience:** Inspect `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers on every Octokit call. If a token approaches exhaustion, delay remaining jobs in BullMQ until the reset timestamp.
* **Renamed, Transferred, or Deleted Repositories:** Track repositories by immutable `githubRepoId`. Automatically update `owner` and `name` upon `301 Moved Permanently` redirects. Mark `pollStatus = 'ERROR'` after 5 consecutive `404 Not Found` responses.
* **XSS & SSRF Protection:**
  * Sanitize all GitHub Markdown changelogs with `rehype-sanitize` before rendering in the panel.
  * Validate custom webhook URLs in `@repopulse/notifications` to block requests to private/loopback IP ranges (`127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`) to prevent SSRF inside the Coolify host network.

---

## 8. Phased Implementation Roadmap

* **Phase 1 — Monorepo & Coolify Foundation (Week 1):** Initialize Turborepo + `pnpm` workspaces (`apps/web`, `apps/worker`, `packages/db`, `packages/github`), configure Prisma/Drizzle schema, and verify `docker-compose.coolify.yml` deployment with healthchecks.
* **Phase 2 — Core Tracking & Panel UI (Week 2):** Implement GitHub OAuth login, repository addition with initial 10-release ingestion, tag/category management, and the split-pane Markdown changelog reader.
* **Phase 3 — BullMQ Polling & Real-Time SSE (Week 3):** Implement conditional `ETag` polling in `apps/worker`, SemVer classification badges, "Sync Now" queue trigger, and Redis Pub/Sub to SSE live UI updates.
* **Phase 4 — Notifications & Self-Hosted Integrations (Week 4):** Build `@repopulse/notifications` supporting SMTP/Resend, Slack, Discord, Ntfy, and Gotify with per-tag routing rules, plus bulk "Import from GitHub Stars".