import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { WebhookUrlError } from "./errors.js";

/**
 * SSRF protection for user-supplied webhook URLs. In a Coolify deployment the worker shares a
 * Docker network with Postgres, Redis and the host, so a webhook must never reach a private,
 * loopback or cloud-metadata address unless the operator opts in.
 *
 * Two layers:
 * 1. `validateWebhookUrl` checks the URL and every address its hostname resolves to (rule creation,
 *    and again before each delivery).
 * 2. `createGuardedLookup` re-checks inside the socket's DNS lookup, so the address that is
 *    actually connected to is the one that was checked (no DNS-rebinding window).
 */

/** Private networks that `ALLOW_INTERNAL_WEBHOOK_HOSTS` can open up (self-hosted Gotify/ntfy). */
const internal = new BlockList();
internal.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
internal.addSubnet("10.0.0.0", 8, "ipv4");
internal.addSubnet("172.16.0.0", 12, "ipv4"); // includes Docker's default bridge networks
internal.addSubnet("192.168.0.0", 16, "ipv4");
internal.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT (Tailscale and similar)
internal.addAddress("::1", "ipv6");
internal.addSubnet("fc00::", 7, "ipv6"); // unique local

/** Never reachable, even with the opt-in: link-local (cloud metadata), unspecified, multicast, reserved. */
const forbidden = new BlockList();
forbidden.addSubnet("0.0.0.0", 8, "ipv4");
forbidden.addSubnet("169.254.0.0", 16, "ipv4"); // 169.254.169.254 = AWS/GCP/Azure metadata
forbidden.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
forbidden.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + broadcast
forbidden.addAddress("::", "ipv6");
forbidden.addSubnet("fe80::", 10, "ipv6"); // link-local
forbidden.addSubnet("ff00::", 8, "ipv6"); // multicast

/**
 * Which hosts may resolve to internal addresses: none (default), all (`true`), or a list of
 * hostnames (`ALLOW_INTERNAL_WEBHOOK_HOSTS=gotify,ntfy.lan`).
 */
export type InternalHostsPolicy = { mode: "none" } | { mode: "all" } | { mode: "list"; hosts: ReadonlySet<string> };

export function parseInternalHostsPolicy(raw: string | undefined): InternalHostsPolicy {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "" || value === "false" || value === "0" || value === "no") return { mode: "none" };
  if (value === "true" || value === "1" || value === "yes" || value === "*") return { mode: "all" };
  const hosts = value
    .split(",")
    .map((host) => host.trim().replace(/\.$/, ""))
    .filter(Boolean);
  return hosts.length > 0 ? { mode: "list", hosts: new Set(hosts) } : { mode: "none" };
}

export function internalHostsPolicyFromEnv(env: Record<string, string | undefined> = process.env): InternalHostsPolicy {
  return parseInternalHostsPolicy(env.ALLOW_INTERNAL_WEBHOOK_HOSTS);
}

/** `::ffff:127.0.0.1` / `::ffff:7f00:1` → `127.0.0.1`; anything else unchanged. */
function unmapIPv4(address: string): string {
  const lower = address.toLowerCase();
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted?.[1]) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return address;
}

export type AddressClass = "public" | "internal" | "forbidden";

/** Classifies one resolved IP address. Unparseable input counts as forbidden. */
export function classifyAddress(address: string): AddressClass {
  const ip = unmapIPv4(address.replace(/^\[|\]$/g, "").replace(/%.*$/, ""));
  const family = isIP(ip);
  if (family === 0) return "forbidden";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (forbidden.check(ip, type)) return "forbidden";
  if (internal.check(ip, type)) return "internal";
  return "public";
}

function hostAllowsInternal(hostname: string, policy: InternalHostsPolicy): boolean {
  if (policy.mode === "all") return true;
  if (policy.mode === "list") return policy.hosts.has(hostname.toLowerCase().replace(/\.$/, ""));
  return false;
}

/** The reason an address may not be contacted for `hostname`, or `null` when it may. */
function blockReason(hostname: string, address: string, policy: InternalHostsPolicy): string | null {
  const kind = classifyAddress(address);
  if (kind === "public") return null;
  if (kind === "internal" && hostAllowsInternal(hostname, policy)) return null;
  const target = hostname === address ? address : `${hostname} (${address})`;
  return kind === "forbidden"
    ? `${target} is a link-local, metadata or reserved address and can never receive webhooks.`
    : `${target} is a private or loopback address. Set ALLOW_INTERNAL_WEBHOOK_HOSTS on the server to allow internal hosts.`;
}

export type ResolveAll = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolveAll: ResolveAll = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export interface ValidateWebhookUrlOptions {
  policy?: InternalHostsPolicy;
  /** DNS resolver (tests). */
  resolveAll?: ResolveAll;
}

/** URL hostname without IPv6 brackets. */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/**
 * Parses `urlString`, requires `http:`/`https:`, resolves the hostname and rejects it when any
 * resolved address is blocked. Throws `WebhookUrlError` (a permanent `NotificationDeliveryError`).
 */
export async function validateWebhookUrl(urlString: string, options: ValidateWebhookUrlOptions = {}): Promise<URL> {
  const policy = options.policy ?? internalHostsPolicyFromEnv();
  const resolveAll = options.resolveAll ?? defaultResolveAll;

  let url: URL;
  try {
    url = new URL(urlString.trim());
  } catch {
    throw new WebhookUrlError("Enter a valid URL, starting with https://");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebhookUrlError(`Only http:// and https:// URLs are supported (got ${url.protocol.replace(/:$/, "")}).`);
  }
  const hostname = bareHostname(url);
  if (!hostname) throw new WebhookUrlError("The URL has no host name.");

  let addresses: LookupAddress[];
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await resolveAll(hostname);
    } catch (error) {
      throw new WebhookUrlError(`Could not resolve ${hostname}. Check the host name.`, error);
    }
  }
  if (addresses.length === 0) throw new WebhookUrlError(`Could not resolve ${hostname}. Check the host name.`);

  for (const { address } of addresses) {
    const reason = blockReason(hostname, address, policy);
    if (reason) throw new WebhookUrlError(reason);
  }
  return url;
}

/**
 * A `net` lookup function that resolves like `dns.lookup` but fails the connection when any
 * address is blocked. Handles both call shapes (`all: true` is used by Happy Eyeballs).
 */
export function createGuardedLookup(policy: InternalHostsPolicy, resolveAll: ResolveAll = defaultResolveAll): LookupFunction {
  return (hostname, options, callback) => {
    resolveAll(hostname).then(
      (resolved) => {
        const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
        const addresses = family === 4 || family === 6 ? resolved.filter((a) => a.family === family) : resolved;
        for (const { address } of addresses) {
          const reason = blockReason(hostname, address, policy);
          if (reason) {
            callback(new WebhookUrlError(reason), "", 0);
            return;
          }
        }
        const first = addresses[0];
        if (!first) {
          const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
          callback(error, "", 0);
          return;
        }
        if (options.all) (callback as unknown as (err: null, addresses: LookupAddress[]) => void)(null, addresses);
        else callback(null, first.address, first.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };
}
