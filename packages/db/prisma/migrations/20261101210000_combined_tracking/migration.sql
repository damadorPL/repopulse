-- "Files / folders" becomes a flag next to the release tracking mode, so one subscription can follow
-- releases (or releases + tags) and watched paths at the same time.

-- AlterTable
ALTER TABLE "UserSubscription" ADD COLUMN     "trackPaths" BOOLEAN NOT NULL DEFAULT false;

-- Existing "Files / folders" subscriptions keep tracking their paths, and no releases.
UPDATE "UserSubscription" SET "trackPaths" = true WHERE "trackMode" = 'PATHS';

-- AlterEnum
ALTER TYPE "TrackMode" RENAME VALUE 'PATHS' TO 'NONE';
