# syntax=docker/dockerfile:1
# Build from the monorepo root:
#   docker build -f apps/worker/Dockerfile --target migrator -t repopulse-migrator .
#   docker build -f apps/worker/Dockerfile -t repopulse-worker .        # runner (default)
FROM node:26-alpine AS base
RUN apk add --no-cache libc6-compat openssl
RUN npm install -g pnpm@12.16.1 turbo@2.11.10
WORKDIR /app

# ---- Stage 1: prune the monorepo down to @repopulse/worker and its workspace deps
FROM base AS pruner
COPY . .
RUN npx turbo prune @repopulse/worker --docker

# ---- Stage 2: install deps (cached on lockfile/package.json) and build
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
# turbo prune preserves the `allowBuilds` block in out/json/pnpm-workspace.yaml,
# so Prisma's install scripts run (pnpm blocks build scripts otherwise) and the
# linux-musl schema engine used by `prisma migrate deploy` is downloaded.
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `build` depends on `^db:generate`, so `prisma generate` runs here on Alpine and
# writes the Prisma 7 client (Rust-free, wasm query compiler) into packages/db/src/generated.
RUN pnpm turbo run build --filter=@repopulse/worker

# ---- Stage 3: drop devDependencies (typescript, tsx, vitest, ...) in place.
# The `prisma` CLI is a runtime dependency of @repopulse/db, so migrations still
# work, and the generated client (packages/db/src/generated + dist) is untouched.
FROM installer AS prod-deps
RUN CI=true pnpm prune --prod \
 && rm -rf node_modules/.cache .turbo apps/*/.turbo packages/*/.turbo

# ---- Target: one-off database migrator (exits 0 once migrations are applied)
FROM base AS migrator
# pnpm verifies/installs deps before running scripts by default; as the non-root
# user that resolves a different store dir than the build used and errors out
# (ERR_PNPM_UNEXPECTED_STORE). node_modules is already complete, so skip it.
ENV NODE_ENV=production \
    pnpm_config_verify_deps_before_run=false
COPY --from=prod-deps /app /app
USER node
CMD ["pnpm", "--filter", "@repopulse/db", "prisma", "migrate", "deploy"]

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
CMD ["node", "apps/worker/dist/index.js"]
