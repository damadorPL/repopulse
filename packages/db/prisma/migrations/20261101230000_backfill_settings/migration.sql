-- Release history import settings, managed by the super admin in Admin -> Release history.
-- NULL = the RELEASE_BACKFILL_* environment variable, or the built-in default.

-- AlterTable
ALTER TABLE "InstanceSettings" ADD COLUMN     "backfillDeepCooldownMinutes" INTEGER,
ADD COLUMN     "backfillDeepStep" INTEGER,
ADD COLUMN     "backfillDefaultTarget" INTEGER,
ADD COLUMN     "backfillHardCap" INTEGER,
ADD COLUMN     "backfillMaxAgeDays" INTEGER,
ADD COLUMN     "backfillMinQuota" INTEGER;
