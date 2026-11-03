# syntax=docker/dockerfile:1
# deps-egress: the allowlist proxy that is deps-sandbox's only way out (Slice 08).
# squid.conf is baked into the image instead of bind-mounted: Coolify does not keep repository files on the host
# for compose deployments, so a `./deploy/...` bind mount would get an empty directory as its source.
# Build context: deploy/deps-egress (see docker-compose.coolify.yml).
FROM ubuntu/squid:6.6-24.04_edge@sha256:8a3baed477e2c282ab8aa5edad442f69873246964f225c5c2ae8364b6610963c
COPY squid.conf /etc/squid/squid.conf
