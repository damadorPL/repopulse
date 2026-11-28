# Dependencies Sandbox (`apps/deps-sandbox`)

> **Summary:** isolated, framework-free `node:http` service on port `3003` that runs pinned package managers (`npm`, `pnpm`, `Bun`, `uv`, `Poetry`) in lockfile-only mode inside a hardened container (`deps_sandbox` internal network + `deps-egress` Squid allowlist proxy). Holds **no** secrets except `DEPS_SANDBOX_TOKEN`.
>
> **Related Docs:** [../CONTRACTS.md](../CONTRACTS.md#sandbox-http-contract) · [../guides/dependencies.md](../guides/dependencies.md) · [../operations/deployment.md](../operations/deployment.md#dependencies-services-network-and-hardening)

## Files

| Concern | File |
| --- | --- |
| HTTP server (`GET /health`, `POST /v1/lock`), auth & body limits | `apps/deps-sandbox/src/{app,server}.ts` |
| Job runner, temp dir lifecycle, risky config detection & deletion, timeouts | `apps/deps-sandbox/src/run-lock.ts` |
| Package manager argument arrays, name/version validation, format checks | `apps/deps-sandbox/src/commands.ts` |
| Tool version probes (`npm --version`, etc.) | `apps/deps-sandbox/src/tools.ts` |
| Structured Pino logger | `apps/deps-sandbox/src/logger.ts` |
| Container entrypoint (`env -i` allowlist) & Debian image | `apps/deps-sandbox/{docker-entrypoint.sh,Dockerfile}` |

## Rules

- **MUST NOT** give `deps-sandbox` any secret beyond `DEPS_SANDBOX_TOKEN` (≥ 16 chars, constant-time SHA-256 bearer check, stripped from `process.env` at startup): no `DATABASE_URL`, `REDIS_URL`, GitHub token, volume, or `env_file`.
- **MUST** keep `apps/deps-sandbox/docker-entrypoint.sh` filtering PID 1's environment via `exec env -i` with its explicit allowlist (Coolify injects `.env` into compose service configs, and child package managers run under the same uid). Add any new sandbox env var to that allowlist.
- **MUST** build child process environments from scratch (`buildSandboxEnv`, never inheriting `process.env`) with scripts disabled, `UV_NO_BUILD=1`, `UV_PYTHON_DOWNLOADS=never`, pnpm auto-download off, Corepack/Yarn absent, and `DEPS_EGRESS_PROXY` (`http://deps-egress:3128` by default).
- **MUST** refuse custom registries (`UNSUPPORTED_REGISTRY`) instead of silently stripping config files (prevents dependency confusion). Risky files (`.npmrc`, `.yarnrc*`, `.pnpmfile.{cjs,mjs}`, `bunfig.toml`, `.bunfig.toml`, `pip.conf`, `pip.ini`, `poetry.toml`, `uv.toml`, `.env`, `.env.*`), stripped directory segments (`node_modules`, `.git`, `.yarn`, `.poetry`, `.venv`), and `[tool.uv.index]` / Poetry sources / `pnpm-workspace.yaml` custom registries are checked in `prepareFiles`, and risky config files / stripped directories are dropped before writing the job tree to disk.
- **MUST** validate package names (`isValidNpmName`, `isValidPythonName`) and versions (`isValidVersion`) before building command argument arrays (never shell strings).
- **MUST** reject pinned unsupported tool majors (`packageManager`, `devEngines`) or lockfile versions outside supported formats (`UNSUPPORTED_TOOL_VERSION`), and verify output lockfile format matches input format.
- **MUST** process at most one `/v1/lock` job at a time (concurrent requests receive `503 BUSY` with `Retry-After: 10`), bound output capture to 1 MiB, and kill the entire process group on timeout (`DEPS_SANDBOX_TIMEOUT_MS`, default 300,000 ms) or client disconnect abort.

## HTTP Contract

See [../CONTRACTS.md](../CONTRACTS.md#sandbox-http-contract) for the full `POST /v1/lock` and `GET /health` Zod contract (`@repopulse/deps/sandbox-contract`).

## Supported Package Manager Commands (`commands.ts`)

| Manager | Command (`cwd` = workspace root) | `LOCKFILE_ONLY` variant | Supported lockfile formats |
| --- | --- | --- | --- |
| `NPM` | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | `npm update --package-lock-only … <names>` | `package-lock.json` v2 / v3, `npm-shrinkwrap.json` (v1 refused) |
| `PNPM` | `pnpm install --no-frozen-lockfile --lockfile-only --ignore-scripts --ignore-pnpmfile` | `pnpm update [--recursive] --no-save --lockfile-only … <names>` | `pnpm-lock.yaml` major `9` |
| `BUN` | `bun install --lockfile-only --ignore-scripts --no-env-file` | `bun update [--recursive] --lockfile-only … <names>`, restore manifests, then `bun install …` | `bun.lock` text v1 / v2 |
| `UV` | `uv lock --upgrade-package <name>==<version> …` | same | `uv.lock` `version = 1` |
| `POETRY` | `poetry --no-plugins --no-interaction --no-ansi lock` | `poetry --no-plugins --no-interaction --no-ansi update --lock <names>` | `poetry.lock` `lock-version = "2.x"` |

## Image, Hardening & Egress

- Base image: `node:26-trixie-slim` (glibc required for Bun and uv binaries), Python 3.13, `tini` PID 1, unprivileged user `sandbox` (uid/gid `10001`).
- Pinned tools in `apps/deps-sandbox/Dockerfile` (`ARG`): npm `12.2.3`, pnpm `12.23.0`, Bun `1.4.5`, uv `0.13.10` (SHA-256 verified), Poetry `2.5.2`. Re-verify `commands.ts` flags and lockfile format constants on every bump.
- Container hardening (`docker-compose.coolify.yml`): `read_only: true`, `tmpfs: /tmp:size=2g`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `pids_limit: 512`, `mem_limit: 2g`, `cpus: 2`, network `deps_sandbox` (`internal: true`) only.
- Outbound proxy (`deploy/deps-egress/squid.conf`): allows `CONNECT` on port `443` only to `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, and `files.pythonhosted.org`, denying everything else including private IP ranges.

## Local Development

`pnpm dev` starts `deps-sandbox` on `:3003` directly on the host with **no container isolation**: set `DEPS_SANDBOX_URL=http://127.0.0.1:3003` for `deps-worker` and `DEPS_EGRESS_PROXY=` (empty) for `deps-sandbox`, or avoid running lockfile PRs locally.
