import { decryptToken, GITHUB_APP_SETTINGS_SELECT, INSTANCE_SETTINGS_ID, prisma } from "@repopulse/db";
import { githubAppPublicUrl, githubAppSettingsUrl } from "@/lib/github-app";

/**
 * What Admin → GitHub App (and the Dependencies pages) may know about the GitHub App. Never contains
 * the private key or the webhook secret: only whether they are saved.
 */
export interface GitHubAppView {
  /** Id, slug and key are all set (the same rule as `loadGitHubAppSettings`). */
  configured: boolean;
  appId: number | null;
  slug: string | null;
  clientId: string | null;
  owner: string | null;
  keySaved: boolean;
  /** `false` when the saved key can't be decrypted (`TOKEN_ENCRYPTION_KEY` changed): re-enter it. */
  keyReadable: boolean;
  webhookSecretSaved: boolean;
  /** `https://github.com/apps/<slug>`: the public page, where users install the App. */
  publicUrl: string | null;
  /** The App's settings page on GitHub. */
  settingsUrl: string | null;
}

function canDecrypt(value: string): boolean {
  try {
    decryptToken(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param viewerLogin the signed-in super admin's GitHub login: an App owned by someone else is assumed
 *   to belong to an organization, whose settings live under `/organizations/<owner>/settings/apps`.
 */
export async function getGitHubAppView(viewerLogin?: string | null): Promise<GitHubAppView> {
  const row = await prisma.instanceSettings.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: GITHUB_APP_SETTINGS_SELECT });
  const slug = row?.githubAppSlug ?? null;
  const owner = row?.githubAppOwner ?? null;
  const keySaved = Boolean(row?.githubAppPrivateKeyEncrypted);
  const ownedByOrganization = owner !== null && (!viewerLogin || owner.toLowerCase() !== viewerLogin.toLowerCase());
  return {
    configured: row?.githubAppId != null && Boolean(slug) && keySaved,
    appId: row?.githubAppId ?? null,
    slug,
    clientId: row?.githubAppClientId ?? null,
    owner,
    keySaved,
    keyReadable: keySaved && canDecrypt(row!.githubAppPrivateKeyEncrypted!),
    webhookSecretSaved: Boolean(row?.githubAppWebhookSecretEncrypted),
    publicUrl: slug ? githubAppPublicUrl(slug) : null,
    settingsUrl: slug ? githubAppSettingsUrl(slug, owner, ownedByOrganization) : null,
  };
}

/** Cheap check (no decryption) for banners and disabled buttons: id, slug and key are set. */
export async function isGitHubAppConfigured(): Promise<boolean> {
  const row = await prisma.instanceSettings.findUnique({
    where: { id: INSTANCE_SETTINGS_ID },
    select: { githubAppId: true, githubAppSlug: true, githubAppPrivateKeyEncrypted: true },
  });
  return row?.githubAppId != null && Boolean(row.githubAppSlug) && Boolean(row.githubAppPrivateKeyEncrypted);
}
