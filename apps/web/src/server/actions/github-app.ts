"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { encryptToken, GitHubAppKeyUnreadableError, INSTANCE_SETTINGS_ID, loadGitHubAppSettings, prisma } from "@repopulse/db";
import { appManifestFormUrl, buildAppManifest, getAuthenticatedApp, GitHubAppAuthError, updateAppWebhookConfig } from "@repopulse/github";
import { resolveAppBaseUrl } from "@repopulse/notifications";
import {
  enableGitHubAppWebhooksInput,
  githubAppManifestInput,
  githubAppManualInput,
  githubAppWebhookTarget,
  type EnableGitHubAppWebhooksInput,
  type GitHubAppManifestInput,
  type GitHubAppManualInput,
} from "@/lib/github-app";
import { fail, invalidInput, ok, toActionError, type ActionResult } from "@/server/action-result";
import {
  createManifestState,
  GITHUB_APP_ADMIN_PATH,
  GITHUB_APP_STATE_COOKIE,
  githubAppStateCookieOptions,
} from "@/server/github-app";
import { getGitHubAppView, type GitHubAppView } from "@/server/queries/github-app";
import { getSuperAdminOrThrow } from "@/server/session";

function revalidateGitHubApp(): void {
  revalidatePath(GITHUB_APP_ADMIN_PATH);
  revalidatePath("/admin");
  revalidatePath("/admin/dependencies");
  revalidatePath("/dependencies", "layout");
}

/**
 * Step 1 of the manifest flow: sets the `state` cookie (httpOnly, sameSite=lax, 10 minutes) and returns
 * where the browser posts the manifest. The client then submits a plain form (`manifest=<json>`) to
 * `formUrl`; GitHub sends the browser back to `/api/github-app/manifest/callback?code=…&state=…`.
 */
export async function startGitHubAppManifestAction(
  input: GitHubAppManifestInput,
): Promise<ActionResult<{ formUrl: string; manifest: string }>> {
  try {
    await getSuperAdminOrThrow();
    const parsed = githubAppManifestInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { organization, name } = parsed.data;

    let manifest: Record<string, unknown>;
    try {
      manifest = buildAppManifest({ appBaseUrl: resolveAppBaseUrl(), ...(name ? { name } : {}) });
    } catch {
      return fail("UNAVAILABLE", "APP_BASE_URL is not a valid http(s) URL. Fix it in the server environment first.");
    }
    const state = createManifestState();
    const formUrl = appManifestFormUrl(state, organization || undefined);
    (await cookies()).set(GITHUB_APP_STATE_COOKIE, state, githubAppStateCookieOptions());
    return ok({ formUrl, manifest: JSON.stringify(manifest) });
  } catch (error) {
    return toActionError(error, "startGitHubAppManifestAction");
  }
}

/**
 * Manual setup (an existing App, or when the manifest flow isn't possible): App id, slug and private key.
 * The pair is validated by signing a JWT and calling `GET /app`; the slug must be the one GitHub returns.
 * Returns the view model, which never contains the key or the webhook secret.
 */
export async function saveGitHubAppSettingsAction(input: GitHubAppManualInput): Promise<ActionResult<GitHubAppView>> {
  try {
    const admin = await getSuperAdminOrThrow();
    const parsed = githubAppManualInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { appId, slug, privateKey, webhookSecret } = parsed.data;

    let app: Awaited<ReturnType<typeof getAuthenticatedApp>>;
    try {
      app = await getAuthenticatedApp({ appId, privateKey });
    } catch (error) {
      if (error instanceof GitHubAppAuthError) return fail("INVALID_INPUT", error.message);
      throw error;
    }
    if (app.id !== appId) return fail("INVALID_INPUT", "GitHub returned a different App for this key. Check the App ID.");
    if (app.slug.toLowerCase() !== slug) {
      return fail("INVALID_INPUT", `This key belongs to the App “${app.slug}”, not “${slug}”. Check the slug.`);
    }

    const current = await prisma.instanceSettings.findUnique({ where: { id: INSTANCE_SETTINGS_ID }, select: { githubAppId: true } });
    // A webhook secret belongs to one App: keep the saved one only when the App is the same.
    const secretUpdate = webhookSecret
      ? { githubAppWebhookSecretEncrypted: encryptToken(webhookSecret) }
      : current?.githubAppId === app.id
        ? {}
        : { githubAppWebhookSecretEncrypted: null };
    const data = {
      githubAppId: app.id,
      githubAppSlug: app.slug,
      githubAppClientId: app.clientId,
      githubAppOwner: app.owner,
      githubAppPrivateKeyEncrypted: encryptToken(privateKey),
      ...secretUpdate,
    };
    await prisma.instanceSettings.upsert({ where: { id: INSTANCE_SETTINGS_ID }, create: { id: INSTANCE_SETTINGS_ID, ...data }, update: data });
    revalidateGitHubApp();
    return ok(await getGitHubAppView(admin.githubLogin));
  } catch (error) {
    return toActionError(error, "saveGitHubAppSettingsAction");
  }
}

/**
 * Forgets the App (id, slug, key, secret). The App itself stays on GitHub: delete it there too. Dependency
 * projects keep working in notify mode; PR modes need an App again.
 */
export async function removeGitHubAppSettingsAction(): Promise<ActionResult<GitHubAppView>> {
  try {
    const admin = await getSuperAdminOrThrow();
    const data = {
      githubAppId: null,
      githubAppSlug: null,
      githubAppClientId: null,
      githubAppOwner: null,
      githubAppPrivateKeyEncrypted: null,
      githubAppWebhookSecretEncrypted: null,
    };
    await prisma.instanceSettings.upsert({ where: { id: INSTANCE_SETTINGS_ID }, create: { id: INSTANCE_SETTINGS_ID, ...data }, update: data });
    revalidateGitHubApp();
    return ok(await getGitHubAppView(admin.githubLogin));
  } catch (error) {
    return toActionError(error, "removeGitHubAppSettingsAction");
  }
}

export interface EnableGitHubAppWebhooksResult {
  /** Where GitHub now delivers the App's webhooks. */
  webhookUrl: string;
  /** A new secret was generated (none was saved, or `rotateSecret`). */
  secretCreated: boolean;
}

/**
 * Part E: points the App's webhook at `<APP_BASE_URL>/api/github-app/webhook` (`PATCH /app/hook/config`,
 * App JWT) with a secret RepoPulse knows: the saved one, or a new random one (32 bytes, hex) stored
 * encrypted once GitHub accepted it. Only offered for a public `https://` APP_BASE_URL.
 *
 * GitHub's API can't activate the hook or subscribe to events: the super admin then ticks "Active"
 * and the Push + Pull request events in the App's settings (the page shows these steps).
 */
export async function enableGitHubAppWebhooksAction(
  input: EnableGitHubAppWebhooksInput = {},
): Promise<ActionResult<EnableGitHubAppWebhooksResult>> {
  try {
    await getSuperAdminOrThrow();
    const parsed = enableGitHubAppWebhooksInput.safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);

    const target = githubAppWebhookTarget(resolveAppBaseUrl());
    if (target.url === null) return fail("UNAVAILABLE", target.reason);

    let app: Awaited<ReturnType<typeof loadGitHubAppSettings>>;
    try {
      app = await loadGitHubAppSettings(prisma);
    } catch (error) {
      if (error instanceof GitHubAppKeyUnreadableError) return fail("UNAVAILABLE", error.message);
      throw error;
    }
    if (!app) return fail("NOT_FOUND", "Set up the GitHub App first.");

    const secretCreated = parsed.data.rotateSecret || !app.webhookSecret;
    const secret = secretCreated || !app.webhookSecret ? randomBytes(32).toString("hex") : app.webhookSecret;
    try {
      await updateAppWebhookConfig({ appId: app.appId, privateKey: app.privateKey }, { url: target.url, secret, contentType: "json" });
    } catch (error) {
      if (error instanceof GitHubAppAuthError) return fail("UNAVAILABLE", error.message);
      throw error;
    }
    // Stored only after GitHub accepted it: a failed call leaves the saved secret (and GitHub's) unchanged.
    if (secretCreated) {
      await prisma.instanceSettings.update({
        where: { id: INSTANCE_SETTINGS_ID },
        data: { githubAppWebhookSecretEncrypted: encryptToken(secret) },
      });
    }
    revalidatePath(GITHUB_APP_ADMIN_PATH);
    return ok({ webhookUrl: target.url, secretCreated });
  } catch (error) {
    return toActionError(error, "enableGitHubAppWebhooksAction");
  }
}
