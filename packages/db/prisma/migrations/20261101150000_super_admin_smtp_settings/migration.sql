-- The first account is the super admin: it manages every instance setting.
ALTER TABLE "User" RENAME COLUMN "isAdmin" TO "isSuperAdmin";

-- SMTP moves from the SMTP_* environment variables to Settings → Email.
ALTER TABLE "InstanceSettings" ADD COLUMN     "smtpFrom" TEXT,
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPasswordEncrypted" TEXT,
ADD COLUMN     "smtpPort" INTEGER NOT NULL DEFAULT 587,
ADD COLUMN     "smtpSecure" BOOLEAN,
ADD COLUMN     "smtpUser" TEXT;
