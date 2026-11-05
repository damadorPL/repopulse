# syntax=docker/dockerfile:1
# Build from the monorepo root:
#   docker build -f apps/deps-sandbox/Dockerfile -t repopulse-deps-sandbox .
#
# deps-sandbox runs package managers (npm, pnpm, Bun, uv, Poetry) on untrusted manifests to regenerate lockfiles
# (Slice 08 §3.10). It holds no secrets except its own bearer token. Compose runs it with a read-only rootfs, a
# tmpfs on /tmp (job dirs, caches), cap_drop ALL, no-new-privileges, pids / memory / CPU limits, on the internal
# `deps_sandbox` network whose only way out is the `deps-egress` allowlist proxy.
#
# Debian slim (glibc) rather than Alpine: the Bun and uv release binaries are glibc builds.

# ---- Build stages: same shape as apps/worker/Dockerfile ----------------------------------------------------------
FROM node:26-trixie-slim AS base
RUN npm install -g pnpm@12.16.1 turbo@2.11.10
WORKDIR /app

# Stage 1: prune the monorepo down to @repopulse/deps-sandbox and its workspace deps
FROM base AS pruner
COPY . .
RUN npx turbo prune @repopulse/deps-sandbox --docker

# Stage 2: install deps (cached on lockfile/package.json) and build
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@repopulse/deps-sandbox

# Stage 3: drop devDependencies (typescript, tsx, vitest, ...) in place
FROM installer AS prod-deps
RUN CI=true pnpm prune --prod \
 && rm -rf node_modules/.cache .turbo apps/*/.turbo packages/*/.turbo

# ---- Runtime --------------------------------------------------------------------------------------------------------
FROM node:26-trixie-slim AS runner

# Pinned tool versions (each released at least two weeks before it was pinned). The tool-version checks in
# src/commands.ts (lockfile formats, packageManager majors) assume these majors: re-check them on every bump.
ARG NPM_VERSION=12.2.2
ARG PNPM_VERSION=12.16.1
ARG BUN_VERSION=1.4.4
ARG UV_VERSION=0.13.7
ARG UV_SHA256_AMD64=c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83
ARG UV_SHA256_ARM64=71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc
ARG POETRY_VERSION=2.5.1
ARG TARGETARCH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# python3 for uv / Poetry, tini as PID 1 (reaps orphaned grandchildren of killed jobs), CA certificates for TLS
# through the CONNECT proxy. curl is only needed to fetch uv and is purged in the same layer. No compilers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 tini \
 && case "${TARGETARCH:-amd64}" in \
      amd64) UV_ARCH=x86_64;  UV_SHA256="${UV_SHA256_AMD64}" ;; \
      arm64) UV_ARCH=aarch64; UV_SHA256="${UV_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/uv.tar.gz \
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_ARCH}-unknown-linux-gnu.tar.gz" \
 && echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 "uv-${UV_ARCH}-unknown-linux-gnu/uv" \
 && rm /tmp/uv.tar.gz \
 && apt-get purge -y --auto-remove curl \
 && rm -rf /var/lib/apt/lists/*

# npm, then the native pnpm and Bun builds straight from their per-platform npm packages (integrity-checked by
# npm, no install scripts). Bun's x64 "baseline" build runs on CPUs without AVX2.
RUN case "${TARGETARCH:-amd64}" in \
      amd64) PNPM_PKG=exe.linux-x64;   BUN_PKG=bun-linux-x64-baseline ;; \
      arm64) PNPM_PKG=exe.linux-arm64; BUN_PKG=bun-linux-aarch64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && npm install -g --ignore-scripts --no-audit --no-fund "npm@${NPM_VERSION}" \
 && npm install -g --ignore-scripts --no-audit --no-fund \
      "@pnpm/${PNPM_PKG}@${PNPM_VERSION}" "@oven/${BUN_PKG}@${BUN_VERSION}" \
 && GLOBAL_MODULES="$(npm root -g)" \
 && install -m 0755 "${GLOBAL_MODULES}/@pnpm/${PNPM_PKG}/pnpm" /usr/local/bin/pnpm \
 && install -m 0755 "${GLOBAL_MODULES}/@oven/${BUN_PKG}/bin/bun" /usr/local/bin/bun \
 && npm uninstall -g "@pnpm/${PNPM_PKG}" "@oven/${BUN_PKG}" \
 # Corepack would download arbitrary package-manager versions (and widen the egress allowlist): remove it and any
 # bundled Yarn. Node 25+ no longer ships Corepack; this is a no-op there.
 && (corepack disable >/dev/null 2>&1 || true) \
 && rm -rf /usr/local/bin/corepack /usr/local/lib/node_modules/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && rm -rf /root/.npm /tmp/*

# Poetry in its own virtualenv (created by uv with the system Python; never downloads a Python).
RUN UV_PYTHON_DOWNLOADS=never uv venv --no-cache --python /usr/bin/python3 /opt/poetry \
 && UV_PYTHON_DOWNLOADS=never uv pip install --no-cache --compile-bytecode --python /opt/poetry/bin/python \
      "poetry==${POETRY_VERSION}" \
 && ln -s /opt/poetry/bin/poetry /usr/local/bin/poetry \
 && npm --version && pnpm --version && bun --version && uv --version && poetry --version

# Unprivileged user for the server and every package manager it starts.
RUN groupadd --system --gid 10001 sandbox \
 && useradd --system --uid 10001 --gid sandbox --home-dir /tmp --no-create-home --shell /usr/sbin/nologin sandbox

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3003 \
    HOME=/tmp \
    DEPS_SANDBOX_TMP_DIR=/tmp \
    COREPACK_ENABLE_STRICT=0 \
    PYTHONDONTWRITEBYTECODE=1
# Root-owned and read-only for the sandbox user. pnpm's relative node_modules symlinks stay valid.
COPY --from=prod-deps --chown=root:root /app /app
# Allowlisted environment for every process (Coolify injects the app's whole .env into each service).
# `sed` strips CR in case the script was checked out with CRLF line endings.
COPY --chown=root:root apps/deps-sandbox/docker-entrypoint.sh /usr/local/bin/deps-sandbox-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/deps-sandbox-entrypoint && chmod 0555 /usr/local/bin/deps-sandbox-entrypoint
USER sandbox
EXPOSE 3003
# `docker exec` (healthchecks) gets the container's full environment: drop it with `env -i` before node starts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "node", "-e", "fetch('http://127.0.0.1:3003/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/deps-sandbox-entrypoint", "/usr/bin/tini", "--"]
CMD ["node", "apps/deps-sandbox/dist/server.js"]
