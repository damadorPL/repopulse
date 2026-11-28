# syntax=docker/dockerfile:1
# Build from the monorepo root:
#   docker build -f apps/worker/Dockerfile --target migrator -t repopulse-migrator .
#   docker build -f apps/worker/Dockerfile -t repopulse-worker .        # runner (default)
FROM node:26-alpine AS base
RUN apk add --no-cache libc6-compat openssl
RUN npm install -g --no-audit --no-fund pnpm@12.23.0 turbo@2.11.13
WORKDIR /app

# ---- Stage 1: prune the monorepo down to @repopulse/worker and its workspace deps
FROM base AS pruner
COPY . .
RUN turbo prune @repopulse/worker --docker

# ---- Stage 2: install deps (cached on lockfile/package.json) and build
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
# turbo prune preserves the `allowBuilds` block in out/json/pnpm-workspace.yaml,
# so Prisma's install scripts run (pnpm blocks build scripts otherwise) and the
# linux-musl schema engine used by `prisma migrate deploy` is downloaded.
# `--filter @repopulse/worker...` skips root devDependencies (oxlint, vitest, react-doctor, etc.).
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @repopulse/worker...
COPY --from=pruner /app/out/full/ .
# `build` depends on `^db:generate`, so `prisma generate` runs here on Alpine and
# writes the Prisma 7 client (Rust-free, wasm query compiler) into packages/db/src/generated.
# Sharing `id=turbo-alpine` across web/worker/deps-worker reuses compiled @repopulse/* packages.
RUN --mount=type=cache,id=turbo-alpine,target=/app/.turbo/cache \
    turbo run build --filter=@repopulse/worker

# ---- Stage 3: drop devDependencies (typescript, tsx, vitest, ...) and unused TypeScript sources in place.
# The `prisma` CLI is a runtime dependency of @repopulse/db, so migrations still
# work, and the generated client (compiled into packages/db/dist) is untouched.
FROM installer AS prod-deps
RUN CI=true pnpm prune --prod --ignore-scripts --filter @repopulse/worker... \
 && rm -rf node_modules/.cache .turbo apps/*/.turbo packages/*/.turbo apps/*/src packages/*/src \
 && find apps packages -not -path '*/node_modules/*' -name '*.test.ts' -delete

# ---- Target: one-off database migrator (exits 0 once migrations are applied)
FROM node:26-alpine AS migrator
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/db ./packages/db
USER node
CMD ["sh", "-c", "node packages/db/node_modules/prisma/build/index.js migrate deploy --config packages/db/prisma.config.ts && node packages/db/dist/bootstrap-app-role.js"]

# ---- Target: production worker runtime (default: last stage)
FROM node:26-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production \
    HEALTH_PORT=3001
# Copy the whole pruned workspace so pnpm's relative node_modules symlinks
# (node_modules/.pnpm/...) and the generated Prisma client stay valid.
COPY --from=prod-deps /app /app
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${HEALTH_PORT:-3001}/health >/dev/null || exit 1
CMD ["node", "apps/worker/dist/index.js"]
