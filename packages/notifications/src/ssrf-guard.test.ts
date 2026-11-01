import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { WebhookUrlError } from "./errors.js";
import {
  classifyAddress,
  createGuardedLookup,
  parseInternalHostsPolicy,
  validateWebhookUrl,
  type InternalHostsPolicy,
  type ResolveAll,
} from "./ssrf-guard.js";

const NONE: InternalHostsPolicy = { mode: "none" };

function resolver(map: Record<string, string[]>): ResolveAll {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

const dns = resolver({
  "discord.com": ["162.159.128.233", "2606:4700::6810:84e5"],
  "hooks.slack.com": ["3.120.0.1"],
  "ntfy.sh": ["159.203.148.75"],
  localhost: ["127.0.0.1", "::1"],
  "gotify.lan": ["192.168.1.20"],
  "rebind.example": ["93.184.216.34", "10.0.0.5"],
  "metadata.example": ["169.254.169.254"],
});

describe("validateWebhookUrl", () => {
  it("blocks http://127.0.0.1:8080", async () => {
    await expect(validateWebhookUrl("http://127.0.0.1:8080", { policy: NONE, resolveAll: dns })).rejects.toThrow(WebhookUrlError);
    await expect(validateWebhookUrl("http://127.0.0.1:8080", { policy: NONE, resolveAll: dns })).rejects.toThrow(/private or loopback/);
  });

  it("blocks the cloud metadata endpoint http://169.254.169.254/latest/meta-data/", async () => {
    await expect(
      validateWebhookUrl("http://169.254.169.254/latest/meta-data/", { policy: NONE, resolveAll: dns }),
    ).rejects.toThrow(/link-local, metadata or reserved/);
  });

  it("allows valid public webhook URLs", async () => {
    const discord = await validateWebhookUrl("https://discord.com/api/webhooks/123/abc", { policy: NONE, resolveAll: dns });
    expect(discord.hostname).toBe("discord.com");
    await expect(
      validateWebhookUrl("https://hooks.slack.com/services/T0/B0/XYZ", { policy: NONE, resolveAll: dns }),
    ).resolves.toBeInstanceOf(URL);
    await expect(validateWebhookUrl("http://ntfy.sh/topic", { policy: NONE, resolveAll: dns })).resolves.toBeInstanceOf(URL);
    await expect(validateWebhookUrl("https://8.8.8.8/hook", { policy: NONE, resolveAll: dns })).resolves.toBeInstanceOf(URL);
  });

  it.each([
    "http://10.1.2.3/hook",
    "http://172.16.0.1/hook",
    "http://172.31.255.254/hook",
    "http://192.168.0.10/hook",
    "http://[::1]:8080/hook",
    "http://[fd12:3456::1]/hook",
    "http://[::ffff:127.0.0.1]/hook",
    "http://0.0.0.0:3000/",
    "http://[fe80::1]/",
  ])("blocks %s", async (url) => {
    await expect(validateWebhookUrl(url, { policy: NONE, resolveAll: dns })).rejects.toThrow(WebhookUrlError);
  });

  it("blocks host names that resolve to a private address, including when only one record is private", async () => {
    await expect(validateWebhookUrl("http://localhost:6379", { policy: NONE, resolveAll: dns })).rejects.toThrow(/localhost \(127\.0\.0\.1\)/);
    await expect(validateWebhookUrl("https://rebind.example/x", { policy: NONE, resolveAll: dns })).rejects.toThrow(/10\.0\.0\.5/);
  });

  it("rejects non-http schemes, garbage and unresolvable hosts", async () => {
    await expect(validateWebhookUrl("ftp://ntfy.sh/topic", { policy: NONE, resolveAll: dns })).rejects.toThrow(/Only http/);
    await expect(validateWebhookUrl("file:///etc/passwd", { policy: NONE, resolveAll: dns })).rejects.toThrow(/Only http/);
    await expect(validateWebhookUrl("not a url", { policy: NONE, resolveAll: dns })).rejects.toThrow(/valid URL/);
    await expect(validateWebhookUrl("https://nope.invalid/", { policy: NONE, resolveAll: dns })).rejects.toThrow(/Could not resolve/);
  });

  it("ALLOW_INTERNAL_WEBHOOK_HOSTS=true opens private ranges but never link-local metadata", async () => {
    const all = parseInternalHostsPolicy("true");
    await expect(validateWebhookUrl("http://127.0.0.1:8080", { policy: all, resolveAll: dns })).resolves.toBeInstanceOf(URL);
    await expect(validateWebhookUrl("http://gotify.lan/message", { policy: all, resolveAll: dns })).resolves.toBeInstanceOf(URL);
    await expect(validateWebhookUrl("http://metadata.example/", { policy: all, resolveAll: dns })).rejects.toThrow(WebhookUrlError);
    await expect(validateWebhookUrl("http://169.254.169.254/latest/meta-data/", { policy: all, resolveAll: dns })).rejects.toThrow(
      WebhookUrlError,
    );
  });

  it("a host list only opens the listed hosts", async () => {
    const list = parseInternalHostsPolicy("gotify.lan, ntfy.internal");
    await expect(validateWebhookUrl("http://gotify.lan/message", { policy: list, resolveAll: dns })).resolves.toBeInstanceOf(URL);
    await expect(validateWebhookUrl("http://localhost:8080", { policy: list, resolveAll: dns })).rejects.toThrow(WebhookUrlError);
  });
});

describe("parseInternalHostsPolicy", () => {
  it.each([
    [undefined, "none"],
    ["", "none"],
    ["false", "none"],
    ["0", "none"],
    ["true", "all"],
    ["TRUE", "all"],
    ["1", "all"],
    ["gotify,ntfy", "list"],
  ])("%s → %s", (raw, mode) => {
    expect(parseInternalHostsPolicy(raw).mode).toBe(mode);
  });
});

describe("classifyAddress", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["2606:4700::1", "public"],
    ["127.0.0.53", "internal"],
    ["172.17.0.2", "internal"],
    ["100.100.1.1", "internal"],
    ["::ffff:7f00:1", "internal"],
    ["169.254.169.254", "forbidden"],
    ["::ffff:169.254.169.254", "forbidden"],
    ["224.0.0.1", "forbidden"],
    ["::", "forbidden"],
    ["garbage", "forbidden"],
  ])("%s is %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe("createGuardedLookup", () => {
  function run(lookup: ReturnType<typeof createGuardedLookup>, hostname: string, all: boolean) {
    return new Promise<{ error: Error | null; result: unknown }>((resolve) => {
      lookup(hostname, { all }, (error, address, family) =>
        resolve({ error, result: all ? address : { address, family } }),
      );
    });
  }

  it("returns public addresses in both call shapes", async () => {
    const lookup = createGuardedLookup(NONE, dns);
    expect((await run(lookup, "discord.com", false)).result).toEqual({ address: "162.159.128.233", family: 4 });
    expect(((await run(lookup, "discord.com", true)).result as LookupAddress[]).length).toBe(2);
  });

  it("fails the connection when the name resolves to a blocked address at connect time", async () => {
    const lookup = createGuardedLookup(NONE, dns);
    const { error } = await run(lookup, "rebind.example", true);
    expect(error).toBeInstanceOf(WebhookUrlError);
  });
});
