# PostgreSQL 18 on Alpine 3.23, bundled with PostgreSQL 16 binaries from the same Alpine release
# so existing PG 16 volumes upgrade automatically in-place via pg_upgrade on first boot.
FROM postgres:16-alpine3.23 AS pg16

FROM postgres:18-alpine3.23

COPY --from=pg16 /usr/local/bin /opt/pg16/bin
COPY --from=pg16 /usr/local/lib /opt/pg16/lib
COPY --from=pg16 /usr/local/share/postgresql /opt/pg16/share/postgresql

# Strip CR in case the script was checked out with CRLF line endings on Windows.
COPY docker-entrypoint-upgrade.sh /usr/local/bin/docker-entrypoint-upgrade.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint-upgrade.sh \
 && chmod 0755 /usr/local/bin/docker-entrypoint-upgrade.sh

ENTRYPOINT ["docker-entrypoint-upgrade.sh"]
CMD ["postgres"]
