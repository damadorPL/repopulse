-- Slice 08 Part B: the RepoPulse GitHub App, registered by the super admin (Admin -> GitHub App). The private key
-- and the webhook secret are AES-256-GCM encrypted (encryptToken).

-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN     "githubAppClientId" TEXT,
ADD COLUMN     "githubAppId" INTEGER,
ADD COLUMN     "githubAppOwner" TEXT,
ADD COLUMN     "githubAppPrivateKeyEncrypted" TEXT,
ADD COLUMN     "githubAppSlug" TEXT,
ADD COLUMN     "githubAppWebhookSecretEncrypted" TEXT;
