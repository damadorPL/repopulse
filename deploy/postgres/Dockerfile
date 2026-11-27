# PostgreSQL 19 on Alpine 3.24, bundled with PostgreSQL 16 and 18 binaries from the same Alpine release
# so existing PG 16 and PG 18 volumes upgrade automatically in-place via pg_upgrade on first boot.
FROM postgres:16-alpine3.24 AS pg16

FROM postgres:18-alpine3.24 AS pg18

FROM postgres:19-alpine3.24

COPY --from=pg16 /usr/local/bin /opt/pg16/bin
COPY --from=pg16 /usr/local/lib /opt/pg16/lib
COPY --from=pg16 /usr/local/share/postgresql /opt/pg16/share/postgresql

COPY --from=pg18 /usr/local/bin /opt/pg18/bin
COPY --from=pg18 /usr/local/lib /opt/pg18/lib
COPY --from=pg18 /usr/local/share/postgresql /opt/pg18/share/postgresql

# Strip CR in case the script was checked out with CRLF line endings on Windows.
COPY docker-entrypoint-upgrade.sh /usr/local/bin/docker-entrypoint-upgrade.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint-upgrade.sh \
 && chmod 0755 /usr/local/bin/docker-entrypoint-upgrade.sh

ENTRYPOINT ["docker-entrypoint-upgrade.sh"]
CMD [ \
  "postgres", \
  "-c", "shared_preload_libraries=pg_stat_statements", \
  "-c", "pg_stat_statements.track=top", \
  "-c", "shared_buffers=256MB", \
  "-c", "effective_cache_size=768MB", \
  "-c", "work_mem=16MB", \
  "-c", "maintenance_work_mem=128MB", \
  "-c", "random_page_cost=1.1", \
  "-c", "effective_io_concurrency=200", \
  "-c", "jit=off", \
  "-c", "wal_compression=zstd", \
  "-c", "idle_in_transaction_session_timeout=60s", \
  "-c", "idle_session_timeout=10min", \
  "-c", "log_min_duration_statement=500", \
  "-c", "log_lock_waits=on", \
  "-c", "log_temp_files=0" \
]
