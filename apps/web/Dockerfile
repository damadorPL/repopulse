# syntax=docker/dockerfile:1
# Build from the monorepo root:
#   docker build -f apps/web/Dockerfile -t repopulse-web .
FROM node:26-alpine AS base
RUN apk add --no-cache libc6-compat openssl
RUN npm install -g pnpm@12.16.1 turbo@2.11.10
WORKDIR /app

# ---- Stage 1: prune the monorepo down to @repopulse/web and its workspace deps
FROM base AS pruner
COPY . .
RUN npx turbo prune @repopulse/web --docker

# ---- Stage 2: install deps (cached on lockfile/package.json) and build
FROM base AS installer
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
# turbo prune preserves the `allowBuilds` block in out/json/pnpm-workspace.yaml,
# so Prisma's install scripts run (pnpm blocks build scripts otherwise).
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `build` depends on `^db:generate`, so `prisma generate` runs here on Alpine and
# writes the Prisma 7 client into packages/db/src/generated, compiled into db/dist.
RUN pnpm turbo run build --filter=@repopulse/web

# ---- Stage 3: minimal runtime image (default target)
FROM node:26-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

# HOSTNAME="::" (not 0.0.0.0): busybox wget resolves `localhost` to ::1 first, so an
# IPv4-only bind makes `wget http://localhost:3000/api/health` fail with "connection
# refused". "::" listens dual-stack (IPv4 + IPv6), and Node falls back to 0.0.0.0
# automatically when IPv6 is disabled in the container.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME="::" \
    NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

# Standalone output is rooted at the monorepo root (outputFileTracingRoot), so the
# server entrypoint lands at apps/web/server.js alongside a pruned node_modules.
COPY --from=installer --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
