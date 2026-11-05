import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getAppWebhookConfig, signWebhookPayload, updateAppWebhookConfig, verifyWebhookSignature } from "./app-hook.js";
import { GitHubAppAuthError } from "./app.js";
import { GitHubRateLimitError } from "./poller.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const AUTH = { appId: 4242, privateKey };
const SECRET = "0123456789abcdef0123456789abcdef";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" },
  });
}

function fakeFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = { method: init?.method ?? "GET", url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("updateAppWebhookConfig", () => {
  it("PATCHes /app/hook/config with the App JWT, url, json content type and secret", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ url: "https://pulse.example.com/api/github-app/webhook", content_type: "json", secret: "********", insecure_ssl: "0" }),
    );
    const config = await updateAppWebhookConfig(
      AUTH,
      { url: "https://pulse.example.com/api/github-app/webhook", secret: SECRET, contentType: "json" },
      { fetch },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url.pathname).toBe("/app/hook/config");
    expect(calls[0]?.headers.authorization).toMatch(/^bearer /i);
    expect(calls[0]?.body).toEqual({
      url: "https://pulse.example.com/api/github-app/webhook",
      content_type: "json",
      insecure_ssl: "0",
      secret: SECRET,
    });
    expect(config).toEqual({ url: "https://pulse.example.com/api/github-app/webhook", contentType: "json", hasSecret: true, insecureSsl: false });
  });

  it("keeps the stored secret when none is given", async () => {
    const { fetch, calls } = fakeFetch(() => json({ url: "https://x.example/api/github-app/webhook", content_type: "json" }));
    await updateAppWebhookConfig(AUTH, { url: "https://x.example/api/github-app/webhook", contentType: "json" }, { fetch });
    expect(calls[0]?.body).not.toHaveProperty("secret");
  });

  it("rejects malformed or non-https URLs and short secrets before any request", async () => {
    const { fetch } = fakeFetch(() => json({}));
    await expect(updateAppWebhookConfig(AUTH, { url: "not a url", contentType: "json" }, { fetch })).rejects.toThrow(/valid URL/);
    await expect(updateAppWebhookConfig(AUTH, { url: "http://x.example/hook", contentType: "json" }, { fetch })).rejects.toThrow(/https/);
    await expect(updateAppWebhookConfig(AUTH, { url: "https://x.example/hook", secret: "short", contentType: "json" }, { fetch })).rejects.toThrow(
      /16/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps 401 to GitHubAppAuthError without echoing the secret", async () => {
    const { fetch } = fakeFetch(() => json({ message: "Bad credentials" }, 401));
    const error = await updateAppWebhookConfig(AUTH, { url: "https://x.example/hook", secret: SECRET, contentType: "json" }, { fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GitHubAppAuthError);
    expect(String((error as Error).message)).not.toContain(SECRET);
  });
});

describe("getAppWebhookConfig", () => {
  it("maps an unconfigured hook, unknown content_type, insecure_ssl '1', and 401/rate-limit errors", async () => {
    const { fetch, calls } = fakeFetch(() => json({ url: "", content_type: "form", insecure_ssl: 0 }));
    await expect(getAppWebhookConfig(AUTH, { fetch })).resolves.toEqual({ url: null, contentType: "form", hasSecret: false, insecureSsl: false });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/app/hook/config");

    const { fetch: oddFetch } = fakeFetch(() => json({ url: "https://x.io/h", content_type: "xml", insecure_ssl: "1", secret: "***" }));
    await expect(getAppWebhookConfig(AUTH, { fetch: oddFetch })).resolves.toEqual({
      url: "https://x.io/h",
      contentType: null,
      hasSecret: true,
      insecureSsl: true,
    });

    const { fetch: unauthFetch } = fakeFetch(() => json({ message: "Bad credentials" }, 401));
    await expect(getAppWebhookConfig(AUTH, { fetch: unauthFetch })).rejects.toBeInstanceOf(GitHubAppAuthError);

    const { fetch: rateFetch } = fakeFetch(() => json({ message: "rate limit" }, 429));
    await expect(getAppWebhookConfig(AUTH, { fetch: rateFetch })).rejects.toBeInstanceOf(GitHubRateLimitError);
  });
});

describe("verifyWebhookSignature", () => {
  const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const valid = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

  it("accepts GitHub's signature for the raw body (string, Buffer, or padded with whitespace)", () => {
    expect(verifyWebhookSignature(body, valid, SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, `  ${valid} \n`, SECRET)).toBe(true);
    expect(verifyWebhookSignature(Buffer.from(body), valid, SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, valid.toUpperCase().replace("SHA256=", "sha256="), SECRET)).toBe(true);
    expect(signWebhookPayload(body, SECRET)).toBe(valid);
  });

  it("matches GitHub's documented example", () => {
    // https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
    expect(
      verifyWebhookSignature(
        "Hello, World!",
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
        "It's a Secret to Everybody",
      ),
    ).toBe(true);
  });

  it("rejects a wrong secret, a changed body, and malformed or missing headers", () => {
    expect(verifyWebhookSignature(body, valid, "another-secret-value")).toBe(false);
    expect(verifyWebhookSignature(`${body} `, valid, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, valid.replace("sha256=", "sha1="), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, `sha256=${"z".repeat(64)}`, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, valid.slice(0, -2), SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, `${valid}00`, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, valid, "")).toBe(false);
  });
});
