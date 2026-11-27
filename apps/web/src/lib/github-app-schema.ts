import { z } from "zod";
import { GITHUB_APP_KEY_MAX_LENGTH, GITHUB_APP_NAME_MAX, GITHUB_APP_WEBHOOK_SECRET_MAX_LENGTH } from "./github-app";

/** GitHub logins (users and organizations): alphanumerics and single hyphens, at most 39 characters. */
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** App slugs as GitHub generates them from the name: lowercase letters, digits and hyphens. */
const APP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

export const githubAppManifestInput = z.strictObject({
  organization: z
    .string()
    .trim()
    .max(39, "GitHub organization names are at most 39 characters")
    .refine((v) => v === "" || GITHUB_LOGIN_RE.test(v), "Enter the organization's GitHub login, for example my-org")
    .default(""),
  name: z
    .string()
    .trim()
    .max(GITHUB_APP_NAME_MAX, `GitHub App names are at most ${GITHUB_APP_NAME_MAX} characters`)
    .default(""),
});
export type GitHubAppManifestInput = z.input<typeof githubAppManifestInput>;

export const githubAppManualInput = z.strictObject({
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
    .refine(
      (v) => /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(v) && /-----END (?:RSA )?PRIVATE KEY-----/.test(v),
      "Paste the whole .pem file, including the BEGIN and END lines",
    ),
  /** Optional (webhooks are off until Part E). Empty keeps the saved secret when the App id is unchanged. */
  webhookSecret: z
    .string()
    .trim()
    .max(GITHUB_APP_WEBHOOK_SECRET_MAX_LENGTH, "The webhook secret is too long")
    .default(""),
});
export type GitHubAppManualInput = z.input<typeof githubAppManualInput>;

export const enableGitHubAppWebhooksInput = z.strictObject({
  /** Generate a new secret even when one is saved (the old one stops working at once). */
  rotateSecret: z.boolean().default(false),
});
export type EnableGitHubAppWebhooksInput = z.input<typeof enableGitHubAppWebhooksInput>;
