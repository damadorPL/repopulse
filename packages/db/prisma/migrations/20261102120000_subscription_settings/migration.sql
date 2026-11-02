-- Per-subscription settings edited on the repository settings page (Slice 07): pin, personal note, notification
-- level, snooze and the version the user runs. All per user; shared Repository / Release rows are unchanged.

-- CreateEnum
CREATE TYPE "NotificationLevel" AS ENUM ('ALL', 'MINOR_AND_UP', 'MAJOR_ONLY', 'NONE');

-- AlterTable
ALTER TABLE "UserSubscription" ADD COLUMN     "currentVersion" TEXT,
ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "notificationLevel" "NotificationLevel" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "snoozedUntil" TIMESTAMP(3);
