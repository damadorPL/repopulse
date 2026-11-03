#!/bin/sh
# deps-sandbox entrypoint (PID 1): re-exec the command with an allowlisted environment.
#
# Coolify adds `env_file: .env` to every compose service, so this container starts with the app's whole .env
# (database, Redis, auth and encryption secrets). Package managers run here as the same uid as the server and
# could read /proc/<pid>/environ of any process in the container. `exec env -i` replaces PID 1's environment
# before tini and node start, so only the variables below exist in any process of the container.
#
# Usage (Dockerfile): ENTRYPOINT ["deps-sandbox-entrypoint", "/usr/bin/tini", "--"]
set -eu

n=$#
for name in PATH HOME NODE_ENV PORT DEPS_SANDBOX_TOKEN DEPS_SANDBOX_TIMEOUT_MS DEPS_EGRESS_PROXY \
  DEPS_SANDBOX_TMP_DIR COREPACK_ENABLE_STRICT PYTHONDONTWRITEBYTECODE; do
  if eval "[ \"\${$name+set}\" = set ]"; then
    eval "value=\${$name}"
    set -- "$@" "$name=$value"
  fi
done

# Move the original command (the first $n arguments) after the NAME=value assignments.
i=0
while [ "$i" -lt "$n" ]; do
  set -- "$@" "$1"
  shift
  i=$((i + 1))
done

exec env -i "$@"
