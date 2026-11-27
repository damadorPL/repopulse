#!/bin/sh
set -eu

# Automatic PostgreSQL 16/18 -> 19 upgrade entrypoint for RepoPulse.
#
# Prior RepoPulse releases used either:
#   - `postgres:16-alpine` mounted at `/var/lib/postgresql/data` (cluster files at `/var/lib/postgresql`), or
#   - `postgres:18-alpine3.23` mounted at `/var/lib/postgresql` (cluster files at `/var/lib/postgresql/18/docker`).
# PostgreSQL 19 mounts `postgres_data` at `/var/lib/postgresql` and stores its cluster in `/var/lib/postgresql/19/docker`.
#
# On startup:
#   1. If PG 19 already exists (`$NEW_PGDATA/PG_VERSION`), hand off immediately to `docker-entrypoint.sh`.
#   2. If a PG 18 cluster exists at `/var/lib/postgresql/18/docker/PG_VERSION`, move it aside to
#      `/var/lib/postgresql/18-pre-upgrade` and run `pg_upgrade` (copy mode) into `$NEW_PGDATA`.
#   3. If a legacy PG 16 cluster is found at `/var/lib/postgresql/PG_VERSION`, move it aside to
#      `/var/lib/postgresql/16-pre-upgrade` and run `pg_upgrade` (copy mode) into `$NEW_PGDATA`.
#      The old cluster is kept intact as a backup until you choose to remove it.
#   4. If none exist (fresh install), hand off to `docker-entrypoint.sh` to initialize PG 19.

PG_ROOT="/var/lib/postgresql"
NEW_PGDATA="${PGDATA:-${PG_ROOT}/19/docker}"
PG19_BIN="/usr/local/bin"

log() {
  printf '[repopulse-pg-upgrade] %s\n' "$*" >&2
}

# Only run upgrade checks when starting the postgres server as root (matches docker-entrypoint.sh).
if [ "${1:-}" != "postgres" ] && [ "${1:-}" != "" ] && [ "${1#-}" = "${1:-}" ]; then
  exec docker-entrypoint.sh "$@"
fi

if [ "$(id -u)" -ne 0 ]; then
  exec docker-entrypoint.sh "$@"
fi

# Case 1: Already running PostgreSQL 19.
if [ -s "${NEW_PGDATA}/PG_VERSION" ]; then
  exec docker-entrypoint.sh "$@"
fi

# Case 2a: Existing PG 18 cluster at /var/lib/postgresql/18/docker -> move aside to 18-pre-upgrade.
if [ -s "${PG_ROOT}/18/docker/PG_VERSION" ]; then
  OLD_VER="$(tr -d '[:space:]' < "${PG_ROOT}/18/docker/PG_VERSION")"
  if [ "${OLD_VER}" != "18" ]; then
    log "ERROR: Found PostgreSQL ${OLD_VER} cluster at ${PG_ROOT}/18/docker; expected 18."
    exit 1
  fi

  PG18_BACKUP="${PG_ROOT}/18-pre-upgrade"
  if [ -e "${PG18_BACKUP}" ]; then
    log "ERROR: Both ${PG_ROOT}/18/docker/PG_VERSION and ${PG18_BACKUP} exist; refusing to overwrite existing backup."
    exit 1
  fi

  log "Detected PostgreSQL 18 cluster at ${PG_ROOT}/18/docker; moving to ${PG18_BACKUP} before upgrading to PostgreSQL 19..."
  mv "${PG_ROOT}/18/docker" "${PG18_BACKUP}"
  rmdir "${PG_ROOT}/18" 2>/dev/null || true
  chown -R postgres:postgres "${PG18_BACKUP}"
  chmod 0700 "${PG18_BACKUP}"
fi

# Case 2b: Legacy PG 16 files sitting at the root of the volume -> move aside to 16-pre-upgrade.
if [ -s "${PG_ROOT}/PG_VERSION" ]; then
  OLD_VER="$(tr -d '[:space:]' < "${PG_ROOT}/PG_VERSION")"
  if [ "${OLD_VER}" != "16" ]; then
    log "ERROR: Found PostgreSQL ${OLD_VER} cluster at ${PG_ROOT}; automatic upgrade only supports 16/18 -> 19."
    exit 1
  fi

  PG16_BACKUP="${PG_ROOT}/16-pre-upgrade"
  if [ -e "${PG16_BACKUP}" ]; then
    log "ERROR: Both ${PG_ROOT}/PG_VERSION and ${PG16_BACKUP} exist; refusing to overwrite existing backup."
    exit 1
  fi

  log "Detected PostgreSQL 16 cluster at ${PG_ROOT}; moving to ${PG16_BACKUP} before upgrading to PostgreSQL 19..."
  mkdir -p "${PG16_BACKUP}"
  for entry in "${PG_ROOT}"/* "${PG_ROOT}"/.*; do
    base="$(basename "${entry}")"
    case "${base}" in
      .|..|18|19|16-pre-upgrade|18-pre-upgrade|lost+found) continue ;;
    esac
    [ -e "${entry}" ] || [ -L "${entry}" ] || continue
    mv "${entry}" "${PG16_BACKUP}/"
  done
  chown -R postgres:postgres "${PG16_BACKUP}"
  chmod 0700 "${PG16_BACKUP}"
fi

# Case 3: Upgrade from *-pre-upgrade -> PG 19 (handles both first attempt and retry after an interruption).
OLD_VER=""
OLD_BACKUP=""
OLD_BIN=""
OLD_LIB=""

if [ -s "${PG_ROOT}/18-pre-upgrade/PG_VERSION" ]; then
  OLD_VER="18"
  OLD_BACKUP="${PG_ROOT}/18-pre-upgrade"
  OLD_BIN="/opt/pg18/bin"
  OLD_LIB="/opt/pg18/lib"
elif [ -s "${PG_ROOT}/16-pre-upgrade/PG_VERSION" ]; then
  OLD_VER="16"
  OLD_BACKUP="${PG_ROOT}/16-pre-upgrade"
  OLD_BIN="/opt/pg16/bin"
  OLD_LIB="/opt/pg16/lib"
fi

if [ -n "${OLD_BACKUP}" ]; then
  BACKUP_VER="$(tr -d '[:space:]' < "${OLD_BACKUP}/PG_VERSION")"
  if [ "${BACKUP_VER}" != "${OLD_VER}" ]; then
    log "ERROR: Expected PostgreSQL ${OLD_VER} in ${OLD_BACKUP}, found ${BACKUP_VER}."
    exit 1
  fi

  WORK_DIR="/tmp/pg-upgrade-work"
  STAGING_PGDATA="${NEW_PGDATA}.tmp"

  rm -rf "${WORK_DIR}" "${STAGING_PGDATA}"
  mkdir -p "${WORK_DIR}" "$(dirname "${NEW_PGDATA}")" "${STAGING_PGDATA}"
  chown -R postgres:postgres "${WORK_DIR}" "$(dirname "${NEW_PGDATA}")" "${STAGING_PGDATA}" "${OLD_BACKUP}"
  chmod 0700 "${STAGING_PGDATA}" "${OLD_BACKUP}"

  # Ensure the old cluster is cleanly shut down (replays WAL if the previous container was killed)
  # and inspect its exact superuser, encoding, and locale so PG 19 initdb matches them.
  log "Starting PostgreSQL ${OLD_VER} briefly for crash recovery and cluster inspection..."
  gosu postgres env LD_LIBRARY_PATH="${OLD_LIB}" \
    "${OLD_BIN}/pg_ctl" -D "${OLD_BACKUP}" \
    -o "-c listen_addresses='' -k ${WORK_DIR}" \
    -l "${WORK_DIR}/pg${OLD_VER}-inspect.log" -w start

  PG_SUPERUSER="${POSTGRES_USER:-repopulse}"
  INSPECT_USER=""
  for candidate in "${PG_SUPERUSER}" postgres; do
    if gosu postgres env LD_LIBRARY_PATH="${OLD_LIB}" PGPASSWORD="${POSTGRES_PASSWORD:-}" \
      "${OLD_BIN}/psql" -h "${WORK_DIR}" -U "${candidate}" -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
      INSPECT_USER="${candidate}"
      break
    fi
  done

  if [ -n "${INSPECT_USER}" ]; then
    DETECTED_SUPER="$(gosu postgres env LD_LIBRARY_PATH="${OLD_LIB}" PGPASSWORD="${POSTGRES_PASSWORD:-}" \
      "${OLD_BIN}/psql" -h "${WORK_DIR}" -U "${INSPECT_USER}" -d postgres -tAc \
      "SELECT rolname FROM pg_roles WHERE rolsuper ORDER BY oid LIMIT 1" | tr -d '[:space:]')"
    [ -n "${DETECTED_SUPER}" ] && PG_SUPERUSER="${DETECTED_SUPER}"

    PG_ENCODING="$(gosu postgres env LD_LIBRARY_PATH="${OLD_LIB}" PGPASSWORD="${POSTGRES_PASSWORD:-}" \
      "${OLD_BIN}/psql" -h "${WORK_DIR}" -U "${INSPECT_USER}" -d postgres -tAc \
      "SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = 'template0'" | tr -d '[:space:]')"
    PG_LC_COLLATE="$(gosu postgres env LD_LIBRARY_PATH="${OLD_LIB}" PGPASSWORD="${POSTGRES_PASSWORD:-}" \
      "${OLD_BIN}/psql" -h "${WORK_DIR}" -U "${INSPECT_USER}" -d postgres -tAc \
      "SELECT datcollate FROM pg_database WHERE datname = 'template0'" | tr -d '[:space:]')"
    PG_LC_CTYPE="$(gosu postgres env LD_LIBRARY_PATH="${OLD_LIB}" PGPASSWORD="${POSTGRES_PASSWORD:-}" \
      "${OLD_BIN}/psql" -h "${WORK_DIR}" -U "${INSPECT_USER}" -d postgres -tAc \
      "SELECT datctype FROM pg_database WHERE datname = 'template0'" | tr -d '[:space:]')"
  else
    PG_ENCODING="UTF8"
    PG_LC_COLLATE="${LANG:-en_US.utf8}"
    PG_LC_CTYPE="${LANG:-en_US.utf8}"
  fi

  gosu postgres env LD_LIBRARY_PATH="${OLD_LIB}" \
    "${OLD_BIN}/pg_ctl" -D "${OLD_BACKUP}" -m fast -w stop

  # Match data page checksums between old and new clusters (PG 18+ enables them by default, PG 16 disabled them).
  CHECKSUM_VER="$(gosu postgres env LD_LIBRARY_PATH="${OLD_LIB}" \
    "${OLD_BIN}/pg_controldata" "${OLD_BACKUP}" \
    | awk -F: '/Data page checksum version/ { gsub(/[[:space:]]/, "", $2); print $2 }')"
  if [ "${CHECKSUM_VER:-0}" = "0" ]; then
    CHECKSUM_FLAG="--no-data-checksums"
  else
    CHECKSUM_FLAG="--data-checksums"
  fi

  log "Initializing PostgreSQL 19 cluster (user=${PG_SUPERUSER}, encoding=${PG_ENCODING}, lc_collate=${PG_LC_COLLATE}, lc_ctype=${PG_LC_CTYPE}, ${CHECKSUM_FLAG})..."
  gosu postgres "${PG19_BIN}/initdb" \
    -D "${STAGING_PGDATA}" \
    --username="${PG_SUPERUSER}" \
    --encoding="${PG_ENCODING}" \
    --lc-collate="${PG_LC_COLLATE}" \
    --lc-ctype="${PG_LC_CTYPE}" \
    "${CHECKSUM_FLAG}"

  log "Running pg_upgrade from PostgreSQL ${OLD_VER} to PostgreSQL 19 (copy mode)..."
  (
    cd "${WORK_DIR}"
    gosu postgres env PGPASSWORD="${POSTGRES_PASSWORD:-}" \
      "${PG19_BIN}/pg_upgrade" \
      --old-bindir="${OLD_BIN}" \
      --new-bindir="${PG19_BIN}" \
      --old-datadir="${OLD_BACKUP}" \
      --new-datadir="${STAGING_PGDATA}" \
      --username="${PG_SUPERUSER}" \
      --socketdir="${WORK_DIR}"
  )

  # Preserve the existing Docker network auth rules from the previous cluster.
  if [ -f "${OLD_BACKUP}/pg_hba.conf" ]; then
    cp -a "${OLD_BACKUP}/pg_hba.conf" "${STAGING_PGDATA}/pg_hba.conf"
    chown postgres:postgres "${STAGING_PGDATA}/pg_hba.conf"
  fi

  if [ "${OLD_VER}" = "16" ]; then
    log "Rebuilding planner statistics for upgraded PostgreSQL 16 -> 19 cluster..."
    gosu postgres "${PG19_BIN}/pg_ctl" -D "${STAGING_PGDATA}" \
      -o "-c listen_addresses='' -k ${WORK_DIR}" \
      -l "${WORK_DIR}/pg19-analyze.log" -w start
    gosu postgres env PGPASSWORD="${POSTGRES_PASSWORD:-}" \
      "${PG19_BIN}/vacuumdb" --all --analyze-in-stages --username="${PG_SUPERUSER}" --host="${WORK_DIR}"
    gosu postgres "${PG19_BIN}/pg_ctl" -D "${STAGING_PGDATA}" -m fast -w stop
  fi

  # Atomically activate the upgraded PG 19 cluster.
  rm -rf "${NEW_PGDATA}"
  mv "${STAGING_PGDATA}" "${NEW_PGDATA}"
  chown -R postgres:postgres "${NEW_PGDATA}"
  chmod 0700 "${NEW_PGDATA}"
  rm -rf "${WORK_DIR}"

  log "PostgreSQL ${OLD_VER} -> 19 upgrade complete. Original PG ${OLD_VER} files were kept at ${OLD_BACKUP} as a backup."
fi

# Hand off to the official PostgreSQL 19 entrypoint.
exec docker-entrypoint.sh "$@"
