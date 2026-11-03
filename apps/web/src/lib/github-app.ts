import { z } from "zod";

/**
 * GitHub App settings (Admin → GitHub App, Slice 08 Part B): input schemas and messages shared by
 * the forms and the Server Actions. Browser-safe: no secrets, no `@repopulse/*` server packages.
 */

/** GitHub logins (users and organizations): alphanumerics and single hyphens, at most 39 characters. */
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** App slugs as GitHub generates them from the name: lowercase letters, digits and hyphens. */
const APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
/** Same as `GITHUB_APP_NAME_MAX_LENGTH` in `@repopulse/github`. */
export const GITHUB_APP_NAME_MAX = 34;
export const GITHUB_APP_KEY_MAX_LENGTH = 16_384;
export const GITHUB_APP_WEBHOOK_SECRET_MAX_LENGTH = 256;

export const githubAppManifestInput = z
  .object({
    organization: z
      .string()
      .trim()
      .max(39, "GitHub organization names are at most 39 characters")
      .refine((v) => v === "" || GITHUB_LOGIN_RE.test(v), "Enter the organization's GitHub login, for example my-org")
      .default(""),
    name: z.string().trim().max(GITHUB_APP_NAME_MAX, `GitHub App names are at most ${GITHUB_APP_NAME_MAX} characters`).default(""),
  })
  .strict();
export type GitHubAppManifestInput = z.input<typeof githubAppManifestInput>;

export const githubAppManualInput = z
  .object({
    appId: z
      .number("Enter the App ID (a number)")
      .int("The App ID is a whole number")
      .positive("The App ID is a positive number")
      .max(2_147_483_647, "That App ID is too large"),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "Enter the App's slug (the last part of https://github.com/apps/<slug>)")
      .max(100, "The slug is too long")
      .regex(APP_SLUG_RE, "The slug has only lowercase letters, digits and hyphens"),
    privateKey: z
      .string()
      .trim()
      .min(1, "Paste the App's private key (.pem)")
      .max(GITHUB_APP_KEY_MAX_LENGTH, "That private key is too long")
      .refine((v) => /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(v) && /-----END (?:RSA )?PRIVATE KEY-----/.test(v), "Paste the whole .pem file, including the BEGIN and END lines"),
    /** Optional (webhooks are off until Part E). Empty keeps the saved secret when the App id is unchanged. */
    webhookSecret: z.string().trim().max(GITHUB_APP_WEBHOOK_SECRET_MAX_LENGTH, "The webhook secret is too long").default(""),
  })
  .strict();
export type GitHubAppManualInput = z.input<typeof githubAppManualInput>;

/** `?error=<code>` of `/admin/github-app` after the manifest callback. Only these codes are shown. */
export const GITHUB_APP_CALLBACK_ERRORS = {
  state: "The setup link expired or was opened in another browser. Start “Create GitHub App” again.",
  code: "GitHub did not return a setup code. Start “Create GitHub App” again.",
  conversion: "GitHub did not accept the setup code. It can be used only once and expires after an hour: start again.",
  rate_limited: "GitHub's rate limit was reached. Wait a few minutes and start again.",
  unknown: "Creating the GitHub App failed. Check the server logs and try again.",
} as const;
export type GitHubAppCallbackError = keyof typeof GITHUB_APP_CALLBACK_ERRORS;

export function callbackErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(GITHUB_APP_CALLBACK_ERRORS, code) ? GITHUB_APP_CALLBACK_ERRORS[code as GitHubAppCallbackError] : GITHUB_APP_CALLBACK_ERRORS.unknown;
}

/** Public page of an App (also where users install it). */
export function githubAppPublicUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}`;
}

/**
 * The App's settings page on GitHub. Apps owned by an organization live under the organization's
 * settings; a personal App under `/settings/apps`.
 */
export function githubAppSettingsUrl(slug: string, owner: string | null, ownedByOrganization: boolean): string {
  const app = encodeURIComponent(slug);
  return ownedByOrganization && owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/${app}`
    : `https://github.com/settings/apps/${app}`;
}

// ---------------------------------------------------------------------------
// Webhooks (Part E)
// ---------------------------------------------------------------------------

/** Path of the webhook route, relative to `APP_BASE_URL`. */
export const GITHUB_APP_WEBHOOK_PATH = "/api/github-app/webhook";

export const enableGitHubAppWebhooksInput = z
  .object({
    /** Generate a new secret even when one is saved (the old one stops working at once). */
    rotateSecret: z.boolean().default(false),
  })
  .strict();
export type EnableGitHubAppWebhooksInput = z.input<typeof enableGitHubAppWebhooksInput>;

export type GitHubAppWebhookTarget = { url: string; reason: null } | { url: null; reason: string };

const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".test", ".example", ".invalid"];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Where GitHub would deliver the App's webhooks: `<APP_BASE_URL>/api/github-app/webhook`, or the
 * reason webhooks can't be offered. GitHub must reach the URL over the internet with a valid
 * certificate, so it needs `https://` and a public host name (no localhost, private IPs or
 * single-label / internal names).
 */
export function githubAppWebhookTarget(appBaseUrl: string): GitHubAppWebhookTarget {
  let url: URL;
  try {
    url = new URL(appBaseUrl.trim());
  } catch {
    return { url: null, reason: "APP_BASE_URL is not a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { url: null, reason: `GitHub delivers webhooks only to a public https:// address, and APP_BASE_URL is ${url.origin}.` };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.startsWith("[") ||
    isPrivateIpv4(host) ||
    !host.includes(".") ||
    PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return { url: null, reason: `GitHub can't reach ${url.host}: APP_BASE_URL must be a public host name.` };
  }
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return { url: `${base}${GITHUB_APP_WEBHOOK_PATH}`, reason: null };
}

/** Pages of the App's settings on GitHub that the webhook steps link to. */
export function githubAppWebhookSettingsUrls(settingsUrl: string): { general: string; events: string; advanced: string } {
  return { general: settingsUrl, events: `${settingsUrl}/permissions`, advanced: `${settingsUrl}/advanced` };
}
