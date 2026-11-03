import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppOctokit, rethrowAppError, type GitHubAppAuth, type GitHubAppRequestOptions } from "./app.js";

/**
 * GitHub App webhook helpers (Slice 08, Part E).
 *
 * `PATCH /app/hook/config` sets the delivery URL, content type and secret only. GitHub's API can
 * neither activate the hook nor change the subscribed events: the super admin ticks "Active" and the
 * `push` + `pull_request` events in the App's settings (the admin page shows these steps).
 */

export interface AppWebhookConfig {
  url: string | null;
  contentType: "json" | "form" | null;
  /** GitHub never returns the secret, only whether one is set (it answers with a mask). */
  hasSecret: boolean;
  insecureSsl: boolean;
}

export interface UpdateAppWebhookConfigInput {
  url: string;
  /** Omit to keep the stored secret. Never logged or echoed in errors. */
  secret?: string;
  contentType: "json";
}

interface WebhookConfigData {
  url?: string;
  content_type?: string;
  secret?: string;
  insecure_ssl?: string | number;
}

function mapConfig(data: WebhookConfigData): AppWebhookConfig {
  const contentType = data.content_type === "json" || data.content_type === "form" ? data.content_type : null;
  return {
    url: data.url || null,
    contentType,
    hasSecret: Boolean(data.secret),
    insecureSsl: String(data.insecure_ssl ?? "0") === "1",
  };
}

function assertHttpsUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The webhook URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("The webhook URL must use https.");
}

/** `GET /app/hook/config` (App JWT). */
export async function getAppWebhookConfig(auth: GitHubAppAuth, options: GitHubAppRequestOptions = {}): Promise<AppWebhookConfig> {
  const octokit = createAppOctokit(auth, options);
  try {
    const response = await octokit.request("GET /app/hook/config");
    return mapConfig(response.data as WebhookConfigData);
  } catch (error) {
    rethrowAppError(error);
  }
}

/**
 * `PATCH /app/hook/config` (App JWT): delivery URL (https only), `json` content type, TLS
 * verification on, and the secret when given.
 */
export async function updateAppWebhookConfig(
  auth: GitHubAppAuth,
  input: UpdateAppWebhookConfigInput,
  options: GitHubAppRequestOptions = {},
): Promise<AppWebhookConfig> {
  assertHttpsUrl(input.url);
  if (input.secret !== undefined && input.secret.length < 16) throw new Error("The webhook secret must be at least 16 characters.");
  const octokit = createAppOctokit(auth, options);
  try {
    // The body goes in `data`: a top-level `url` parameter would replace the route's own URL in Octokit.
    const response = await octokit.request("PATCH /app/hook/config", {
      data: {
        url: input.url,
        content_type: input.contentType,
        insecure_ssl: "0",
        ...(input.secret !== undefined ? { secret: input.secret } : {}),
      },
    });
    return mapConfig(response.data as WebhookConfigData);
  } catch (error) {
    rethrowAppError(error);
  }
}

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

/**
 * Verifies `X-Hub-Signature-256` (`sha256=<hex HMAC-SHA256 of the raw body>`) in constant time.
 * `false` for a missing / malformed header or an empty secret.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | null, secret: string): boolean {
  if (!secret || !signatureHeader) return false;
  const match = SIGNATURE_PATTERN.exec(signatureHeader.trim());
  if (!match?.[1]) return false;
  const received = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/** `sha256=<hex>` for a body: what GitHub sends (tests and local tooling). */
export function signWebhookPayload(rawBody: Buffer | string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
