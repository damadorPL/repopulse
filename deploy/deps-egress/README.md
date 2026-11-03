# deps-egress

Allowlist forward proxy for `deps-sandbox` (Slice 08 §3.10.4). `deps-sandbox` sits on the internal `deps_sandbox`
network and reaches the internet only through this proxy. [`squid.conf`](./squid.conf) allows HTTPS tunnels
(`CONNECT`) on port 443 to these hosts only:

- `registry.npmjs.org`, `registry.yarnpkg.com` (npm, pnpm, Bun)
- `pypi.org`, `files.pythonhosted.org` (uv, Poetry)

Everything else is denied: plain HTTP, other hosts or ports, raw IPs, and any name that resolves to a private,
loopback, link-local or multicast address. Nothing is cached. The access log has one line per request (time,
client, method, `host:port`, status) and no query strings.

## Image

Use a pinned Squid image, for example:

```yaml
image: ubuntu/squid:6.6-24.04_edge@sha256:8a3baed477e2c282ab8aa5edad442f69873246964f225c5c2ae8364b6610963c
volumes:
  - ./deploy/deps-egress/squid.conf:/etc/squid/squid.conf:ro
```

Squid drops to the `proxy` user, so it writes its logs to `/var/log/squid/`. The image's entrypoint tails those
files to stdout, so `docker logs` shows them.

## Testing the allowlist

From a container on the `deps_sandbox` network (the sandbox itself has no curl, so use a throwaway one):

```sh
NET=$(docker network ls --format '{{.Name}}' | grep deps_sandbox)
# Allowed: 200
docker run --rm --network "$NET" curlimages/curl:8.11.1 -sS -o /dev/null -w '%{http_code}\n' \
  -x http://deps-egress:3128 https://registry.npmjs.org/ms
# Denied: curl fails with "CONNECT tunnel failed, response 403"
docker run --rm --network "$NET" curlimages/curl:8.11.1 -sS -o /dev/null \
  -x http://deps-egress:3128 https://example.com
# No direct route either (internal network): curl times out / cannot resolve
docker run --rm --network "$NET" curlimages/curl:8.11.1 -sS -o /dev/null --max-time 10 https://example.com
```

Check the result with `docker logs deps-egress`: allowed requests show `TCP_TUNNEL`, denied ones `TCP_DENIED`.

## Known limits

- The proxy filters on the `CONNECT` host name and does not inspect TLS. A client that tunnels to an allowed
  host could still send a different `Host` / SNI to the same CDN (domain fronting); the major CDNs reject that, and
  the sandbox holds no secrets to exfiltrate.
- Logs are not rotated (`logfile_rotate 0`); they grow by one line per registry request.
