import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = {
  instanceSettings: { findUnique: vi.fn() },
};
const decryptToken = vi.fn();

vi.mock("@repopulse/db", () => ({
  prisma,
  INSTANCE_SETTINGS_ID: 1,
  GITHUB_APP_SETTINGS_SELECT: {},
  decryptToken,
}));

const { getGitHubAppView, isGitHubAppConfigured } = await import("./github-app");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getGitHubAppView", () => {
  it("computes ownedByOrganization based on viewerLogin and reports keyReadable: false when decryptToken throws", async () => {
    prisma.instanceSettings.findUnique.mockResolvedValue({
      githubAppId: 42,
      githubAppSlug: "repopulse-app",
      githubAppClientId: "Iv1.123",
      githubAppOwner: "acme-org",
      githubAppPrivateKeyEncrypted: "enc(pem)",
      githubAppWebhookSecretEncrypted: "enc(secret)",
    });

    // Viewer is "alice" !== "acme-org" -> organization settings URL, and key is readable
    decryptToken.mockReturnValueOnce("pem");
    const orgView = await getGitHubAppView("alice");
    expect(orgView).toEqual({
      configured: true,
      appId: 42,
      slug: "repopulse-app",
      clientId: "Iv1.123",
      owner: "acme-org",
      keySaved: true,
      keyReadable: true,
      webhookSecretSaved: true,
      publicUrl: "https://github.com/apps/repopulse-app",
      settingsUrl: "https://github.com/organizations/acme-org/settings/apps/repopulse-app",
    });

    // Viewer matches owner case-insensitively -> personal settings URL, and corrupt key -> keyReadable: false
    decryptToken.mockImplementationOnce(() => {
      throw new Error("bad cipher");
    });
    const personalView = await getGitHubAppView("ACME-ORG");
    expect(personalView).toMatchObject({
      configured: true,
      keySaved: true,
      keyReadable: false,
      settingsUrl: "https://github.com/settings/apps/repopulse-app",
    });
  });

  it("checks whether the GitHub App is configured without decrypting", async () => {
    prisma.instanceSettings.findUnique.mockResolvedValueOnce(null);
    await expect(isGitHubAppConfigured()).resolves.toBe(false);

    prisma.instanceSettings.findUnique.mockResolvedValueOnce({
      githubAppId: 42,
      githubAppSlug: "repopulse-app",
      githubAppPrivateKeyEncrypted: "enc(pem)",
    });
    await expect(isGitHubAppConfigured()).resolves.toBe(true);
    expect(decryptToken).not.toHaveBeenCalled();
  });
});
