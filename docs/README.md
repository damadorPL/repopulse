# RepoPulse Documentation

> **Audience:** coding agents and contributors. Every file starts with a summary and links to related guides, then lists rules (**MUST / MUST NOT**) and technical details. Paths are relative to the repo root unless noted.

RepoPulse is a self-hosted tracker for GitHub releases and changelogs. Users sign in with GitHub and subscribe to repositories. A background worker polls GitHub, stores new releases, marks them unread for every subscriber, pushes live updates over SSE, and delivers notifications (Discord, Slack, ntfy, Gotify, email, custom webhooks). An optional Dependencies module checks users' own repositories for outdated npm, Bun, and PyPI dependencies and can open update pull requests through a GitHub App. It runs as a Turborepo + pnpm monorepo deployed with Docker Compose on Coolify.

## Documentation Index

### Cross-Cutting Architecture & Standards

| Document | Scope |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System overview, workspace DAG, processes, core data flows, and design decisions |
| [CONTRACTS.md](./CONTRACTS.md) | `ActionResult`, SSE events, BullMQ queues, sandbox HTTP contract, webhooks, and Redis keys |
| [CODING_STANDARDS.md](./CODING_STANDARDS.md) | Core invariants, TypeScript 7 / ESM rules, workspace boundaries, testing, and doc hygiene |

### Applications (`docs/apps/`)

| Document | Scope |
| --- | --- |
| [apps/web.md](./apps/web.md) | `@repopulse/web`: Next.js 16 App Router, RSC pages, Server Actions, route handlers, and UI |
| [apps/worker.md](./apps/worker.md) | `@repopulse/worker`: BullMQ release scheduler, ETag poller, history backfill, and notifications |
| [apps/deps-worker.md](./apps/deps-worker.md) | `@repopulse/deps-worker`: BullMQ dependency scanner, PR updater, and outbox notifier |
| [apps/deps-sandbox.md](./apps/deps-sandbox.md) | `@repopulse/deps-sandbox`: isolated HTTP lockfile-regeneration server, tool pins, and egress |

### Shared Packages (`docs/packages/`)

| Document | Scope |
| --- | --- |
| [packages/db.md](./packages/db.md) | `@repopulse/db`: Prisma 7 schema, migrations, data semantics, singleton client, and token crypto |
| [packages/deps.md](./packages/deps.md) | `@repopulse/deps`: pure manifest/lockfile parsers, registries, planner, rewrites, and sandbox contract |
| [packages/github.md](./packages/github.md) | `@repopulse/github`: Octokit wrapper, SemVer classifier, ETag/GraphQL/commit polling, GitHub App, Git Data API |
| [packages/notifications.md](./packages/notifications.md) | `@repopulse/notifications`: channel formatters, dispatchers, two-layer SSRF guard, and SMTP |
| [packages/queue.md](./packages/queue.md) | `@repopulse/queue`: BullMQ queue factories, deduplication helpers, Redis/SSE contracts, health, and Pino logger |

### Cross-Service Guides (`docs/guides/`)

| Document | Scope |
| --- | --- |
| [guides/auth-and-access.md](./guides/auth-and-access.md) | Better Auth GitHub OAuth, super admin bootstrap, invite links, and GitHub App setup |
| [guides/dependencies.md](./guides/dependencies.md) | End-to-end Dependencies module lifecycle, trust boundaries, webhooks, and limits |
| [guides/recipes.md](./guides/recipes.md) | Step-by-step checklists for migrations, actions, settings, queues, SSE, channels, and ecosystems |

### Operations (`docs/operations/`)

| Document | Scope |
| --- | --- |
| [operations/configuration.md](./operations/configuration.md) | Environment variables, non-production `.env` loading, and `env:setup` / `env:sync` scripts |
| [operations/deployment.md](./operations/deployment.md) | Coolify Docker Compose services, image builds, sandbox network hardening, and upgrades |
| [operations/development.md](./operations/development.md) | First-run setup, workspace commands, CI verification, and git / release workflow |

## Where to Look

| If the task involves… | Read |
| --- | --- |
| Overall system, processes, or workspace graph | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Shared payload, queue, SSE, webhook, or sandbox contracts | [CONTRACTS.md](./CONTRACTS.md) |
| Non-negotiable rules, code style, testing, or gotchas | [CODING_STANDARDS.md](./CODING_STANDARDS.md) |
| Prisma models, migrations, or query/state semantics | [packages/db.md](./packages/db.md) |
| Next.js pages, Server Actions, or UI conventions | [apps/web.md](./apps/web.md) |
| Release polling, fan-out, backfill, or scheduler | [apps/worker.md](./apps/worker.md) |
| Dependency scans, PRs, sandbox, egress, or ecosystems | [guides/dependencies.md](./guides/dependencies.md) |
| Notification channels, SSRF guard, SMTP, or Send Test | [packages/notifications.md](./packages/notifications.md) |
| GitHub sign-in, super admin, invites, or GitHub App | [guides/auth-and-access.md](./guides/auth-and-access.md) |
| Environment variables or `.env` scripts | [operations/configuration.md](./operations/configuration.md) |
| Local commands, CI, or git workflow | [operations/development.md](./operations/development.md) |
| Coolify / Docker Compose deployment or upgrades | [operations/deployment.md](./operations/deployment.md) |
| Step-by-step implementation checklists | [guides/recipes.md](./guides/recipes.md) |

Other sources:

- [`AGENTS.md`](../AGENTS.md): root agent guidance and per-workspace `AGENTS.md` router.
- [`apps/web/AGENTS.md`](../apps/web/AGENTS.md): includes the Next.js 16 bundled-docs notice maintained by `next dev`.
- [`README.md`](../README.md): repository overview and quick start.
- [`CHANGELOG.md`](../CHANGELOG.md): Keep a Changelog release history (**update `## [Unreleased]` with every user-visible change**).
- [`PRD/`](../PRD/): historical product specs and implementation summaries (where they disagree with code or `docs/`, the code wins).
