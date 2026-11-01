import http from "node:http";
import https from "node:https";
import { NotificationDeliveryError } from "./errors.js";
import { createGuardedLookup, validateWebhookUrl, type InternalHostsPolicy, type ResolveAll } from "./ssrf-guard.js";

export const USER_AGENT = "RepoPulse-Notifications/1.0";
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Enough of an error response to show the service's message (Discord/Slack reply with short JSON or text). */
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface WebhookRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
  /** Short service name for error messages ("Discord", "ntfy", …). */
  service: string;
  /** Masked destination for error messages; the real URL may contain secrets. */
  destination: string;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

export interface HttpOptions {
  policy: InternalHostsPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  resolveAll?: ResolveAll;
}

/** Sends one webhook request; throws `NotificationDeliveryError` unless the response is 2xx. */
export type WebhookSender = (request: WebhookRequest, options: HttpOptions) => Promise<WebhookResponse>;

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** First line of a JSON `message`/`error` field or of the plain-text body, for error messages. */
export function describeResponseBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["message", "error", "errorDescription", "error_description"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
      }
    }
  } catch {
    // not JSON
  }
  if (/^<(!doctype|html)/i.test(trimmed)) return "";
  return (trimmed.split(/\r?\n/, 1)[0] ?? "").slice(0, 200);
}

/**
 * POSTs with Node's http/https and the SSRF-guarded DNS lookup. Redirects are not followed
 * (a redirect could point at an internal address), there is a hard timeout, and only the first
 * 16 KiB of the response are read.
 */
export const postWebhook: WebhookSender = async (request, options) => {
  // IP-literal hosts never reach the lookup function, so validate the URL itself first.
  const url = await validateWebhookUrl(request.url.href, { policy: options.policy, resolveAll: options.resolveAll });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];
  const signal = AbortSignal.any(signals);
  const transport = url.protocol === "https:" ? https : http;

  const headers: Record<string, string> = { "User-Agent": USER_AGENT, ...request.headers };
  if (url.username || url.password) {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers.Authorization ??= `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  const body = Buffer.from(request.body, "utf8");
  headers["Content-Length"] = String(body.byteLength);

  const response = await new Promise<WebhookResponse>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
        lookup: createGuardedLookup(options.policy, options.resolveAll),
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size >= MAX_RESPONSE_BYTES) return;
          chunks.push(chunk);
          size += chunk.byteLength;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, MAX_RESPONSE_BYTES) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  }).catch((error: unknown) => {
    if (error instanceof NotificationDeliveryError) throw error;
    const timedOut = signals[0]?.aborted === true;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : code ? `failed (${code})` : "failed";
    throw new NotificationDeliveryError(`${request.service} request to ${request.destination} ${detail}.`, {
      permanent: false,
      cause: error,
    });
  });

  if (response.status >= 200 && response.status < 300) return response;

  if (response.status >= 300 && response.status < 400) {
    throw new NotificationDeliveryError(
      `${request.service} answered with a redirect (HTTP ${response.status}); redirects are not followed. Use the final URL.`,
      { permanent: true, status: response.status },
    );
  }
  const detail = describeResponseBody(response.body);
  throw new NotificationDeliveryError(
    `${request.service} rejected the notification: HTTP ${response.status}${detail ? ` (${detail})` : ""}.`,
    { permanent: !isTransientStatus(response.status), status: response.status },
  );
};
