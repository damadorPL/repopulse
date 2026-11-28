/**
 * GitHub App settings (Admin → GitHub App, Slice 08 Part B): limits, URLs and messages shared by
 * the forms and the Server Actions. Browser-safe: no secrets, no `@repopulse/*` server packages,
 * no Zod. Server Action input schemas live in `./github-app-schema`.
 */

/** Same as `GITHUB_APP_NAME_MAX_LENGTH` in `@repopulse/github`. */
export const GITHUB_APP_NAME_MAX = 34;
export const GITHUB_APP_KEY_MAX_LENGTH = 16_384;
export const GITHUB_APP_WEBHOOK_SECRET_MAX_LENGTH = 256;

/** `?error=<code>` of `/admin/github-app` after the manifest callback. Only these codes are shown. */
export const GITHUB_APP_CALLBACK_ERRORS = {
  state: "The setup link expired or was opened in another browser. Start “Create GitHub App” again.",
  code: "GitHub did not return a setup code. Start “Create GitHub App” again.",
  conversion: "GitHub did not accept the setup code. It can be used only once and expires after an hour: start again.",
  rate_limited: "GitHub's rate limit was reached. Wait a few minutes and start again.",
  unknown: "Creating the GitHub App failed. Check the server logs and try again.",
} as const;
export type GitHubAppCallbackError = keyof typeof GITHUB_APP_CALLBACK_ERRORS;

function isCallbackError(code: string): code is GitHubAppCallbackError {
  return Object.hasOwn(GITHUB_APP_CALLBACK_ERRORS, code);
}

export function callbackErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return isCallbackError(code) ? GITHUB_APP_CALLBACK_ERRORS[code] : GITHUB_APP_CALLBACK_ERRORS.unknown;
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
const GITHUB_APP_WEBHOOK_PATH = "/api/github-app/webhook";

export type GitHubAppWebhookTarget = { url: string; reason: null } | { url: null; reason: string };

const PRIVATE_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".intranet",
  ".test",
  ".example",
  ".invalid",
];

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
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
    return {
      url: null,
      reason: `GitHub delivers webhooks only to a public https:// address, and APP_BASE_URL is ${url.origin}.`,
    };
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
export function githubAppWebhookSettingsUrls(settingsUrl: string): {
  general: string;
  events: string;
  advanced: string;
} {
  return { general: settingsUrl, events: `${settingsUrl}/permissions`, advanced: `${settingsUrl}/advanced` };
}
