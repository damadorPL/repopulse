# Agent Implementation Slice 01: Monorepo, Database Schema & Coolify Infrastructure

## 1. Objective & Scope
Initialize the **RepoPulse** Turborepo + `pnpm` workspace monorepo, configure the shared PostgreSQL database package (`@repopulse/db`) with AES-256-GCM token encryption, and set up the production Coolify Docker Compose stack (`docker-compose.coolify.yml`) with multi-stage `turbo prune` Dockerfiles.

* **Prerequisites:** Empty Git repository, Node.js 20+, `pnpm` 9+.
* **Out of Scope:** UI components, GitHub OAuth login flow, Octokit API calls, and BullMQ queue workers (stubbed with healthchecks only in this slice).

---

## 2. Target Files to Create / Modify
```text
repopulse/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── .env.example
├── docker-compose.coolify.yml
├── packages/
│   ├── tsconfig/
│   │   ├── package.json
│   │   ├── base.json
│   │   └── nextjs.json
│   └── db/
│       ├── package.json
│       ├── prisma/
│       │   └── schema.prisma
│       └── src/
│           ├── index.ts
│           └── crypto.ts
└── apps/
    ├── web/
    │   ├── package.json
    │   ├── Dockerfile
    │   └── src/app/api/health/route.ts
    └── worker/
        ├── package.json
        ├── Dockerfile
        └── src/
            ├── index.ts
            └── health.ts
```

---

## 3. Step-by-Step Agent Instructions

### Step 3.1: Workspace & Turborepo Setup
1. Configure `pnpm-workspace.yaml` to include `apps/*` and `packages/*`.
2. Configure `turbo.json` with tasks: `build`, `dev` (`persistent: true`, `cache: false`), `lint`, `typecheck`, `db:generate`, and `db:migrate:deploy`.
3. Create `packages/tsconfig/base.json` with `"strict": true`, `"moduleResolution": "bundler"`, and `"target": "ES2022"`.

### Step 3.2: Database Schema (`packages/db/prisma/schema.prisma`)
Implement the exact Prisma schema below:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum PollStatus {
  IDLE
  POLLING
  ERROR
}

enum SemverType {
  MAJOR
  MINOR
  PATCH
  PRERELEASE
  OTHER
}

enum TrackMode {
  RELEASES
  TAGS_AND_COMMITS
}

enum NotificationChannel {
  IN_APP
  EMAIL_INSTANT
  EMAIL_DIGEST
  DISCORD_WEBHOOK
  SLACK_WEBHOOK
  NTFY_WEBHOOK
  GOTIFY_WEBHOOK
  CUSTOM_WEBHOOK
}

model User {
  id                         String              @id @default(cuid())
  email                      String              @unique
  name                       String?
  avatarUrl                  String?
  githubId                   String              @unique
  githubAccessTokenEncrypted String?
  createdAt                  DateTime            @default(now())
  updatedAt                  DateTime            @updatedAt
  subscriptions              UserSubscription[]
  tags                       Tag[]
  releaseStates              UserReleaseState[]
  notificationRules          NotificationRule[]
}

model Repository {
  id            String             @id @default(cuid())
  githubRepoId  Int                @unique
  owner         String
  name          String
  fullName      String             @unique
  description   String?
  avatarUrl     String?
  htmlUrl       String
  starsCount    Int                @default(0)
  lastPolledAt  DateTime?
  lastEtag      String?
  pollStatus    PollStatus         @default(IDLE)
  errorCount    Int                @default(0)
  createdAt     DateTime           @default(now())
  updatedAt     DateTime           @updatedAt
  releases      Release[]
  subscriptions UserSubscription[]

  @@index([lastPolledAt, pollStatus])
}

model Release {
  id              String             @id @default(cuid())
  repositoryId    String
  githubReleaseId BigInt
  tagName         String
  title           String
  bodyMarkdown    String             @db.Text
  htmlUrl         String
  isPrerelease    Boolean            @default(false)
  isDraft         Boolean            @default(false)
  semverType      SemverType         @default(OTHER)
  publishedAt     DateTime
  discoveredAt    DateTime           @default(now())
  repository      Repository         @relation(fields: [repositoryId], references: [id], onDelete: Cascade)
  userStates      UserReleaseState[]

  @@unique([repositoryId, githubReleaseId])
  @@index([repositoryId, publishedAt(sort: Desc)])
}

model UserSubscription {
  id                 String            @id @default(cuid())
  userId             String
  repositoryId       String
  includePrereleases Boolean           @default(false)
  trackMode          TrackMode         @default(RELEASES)
  createdAt          DateTime          @default(now())
  user               User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  repository         Repository        @relation(fields: [repositoryId], references: [id], onDelete: Cascade)
  tags               SubscriptionTag[]

  @@unique([userId, repositoryId])
}

model Tag {
  id                String             @id @default(cuid())
  userId            String
  name              String
  slug              String
  colorHex          String             @default("#3B82F6")
  user              User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  subscriptions     SubscriptionTag[]
  notificationRules NotificationRule[]

  @@unique([userId, slug])
}

model SubscriptionTag {
  subscriptionId String
  tagId          String
  subscription   UserSubscription @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)
  tag            Tag              @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@id([subscriptionId, tagId])
}

model UserReleaseState {
  userId    String
  releaseId String
  isRead    Boolean   @default(false)
  readAt    DateTime?
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  release   Release   @relation(fields: [releaseId], references: [id], onDelete: Cascade)

  @@id([userId, releaseId])
  @@index([userId, isRead])
}

model NotificationRule {
  id                String              @id @default(cuid())
  userId            String
  tagId             String?
  channel           NotificationChannel
  destinationUrl    String?
  onlyMajorReleases Boolean             @default(false)
  enabled           Boolean             @default(true)
  createdAt         DateTime            @default(now())
  user              User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  tag               Tag?                @relation(fields: [tagId], references: [id], onDelete: SetNull)
}
```

### Step 3.3: AES-256-GCM Token Encryption (`packages/db/src/crypto.ts`)
1. Implement `encryptToken(plainText: string): string` and `decryptToken(cipherText: string): string` using Node's built-in `node:crypto` module (`aes-256-gcm`).
2. Read the 64-character hex `TOKEN_ENCRYPTION_KEY` from `process.env.TOKEN_ENCRYPTION_KEY`.
3. Format output as `ivHex:authTagHex:encryptedHex`.
4. Re-export `prisma` singleton client, all Prisma types, and `{ encryptToken, decryptToken }` from `packages/db/src/index.ts`.

### Step 3.4: Healthcheck Endpoints & Dockerfiles
1. **`apps/web/src/app/api/health/route.ts`**: Execute `await prisma.$queryRaw\`SELECT 1\`` and return `{ status: "ok", timestamp: new Date().toISOString() }` with HTTP `200`.
2. **`apps/worker/src/health.ts`**: Create a lightweight `node:http` server on port `3001` responding to `GET /health` with HTTP `200` after pinging PostgreSQL.
3. **`apps/web/Dockerfile` & `apps/worker/Dockerfile`**:
   * Use `node:20-alpine` with `libc6-compat` and `openssl`.
   * Stage 1 (`pruner`): Run `npx turbo prune @repopulse/web --docker` (or `@repopulse/worker`).
   * Stage 2 (`installer`): Install dependencies via `pnpm install --frozen-lockfile` and build.
   * In `apps/worker/Dockerfile`, include a `migrator` target that runs `pnpm --filter @repopulse/db prisma migrate deploy` and a `runner` target that starts `dist/index.js`.
4. **`docker-compose.coolify.yml`**: Configure `postgres`, `redis` (`--appendonly yes --maxmemory-policy noeviction`), `migrator`, `web`, and `worker` with healthchecks and `depends_on` conditions.

---

## 4. Verification & Acceptance Criteria
- [ ] Running `pnpm install && pnpm --filter @repopulse/db db:generate && pnpm typecheck` succeeds with 0 errors.
- [ ] Unit test on `encryptToken` and `decryptToken` verifies round-trip encryption and throws on tampered ciphertext.
- [ ] Running `docker compose -f docker-compose.coolify.yml build` completes successfully for both `web`, `worker`, and `migrator` targets.