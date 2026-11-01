-- AlterEnum
ALTER TYPE "TrackMode" ADD VALUE 'PATHS';

-- AlterEnum
ALTER TYPE "ReleaseSource" ADD VALUE 'COMMIT';

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "lastPathsPolledAt" TIMESTAMP(3),
ADD COLUMN     "polledPaths" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Release" ADD COLUMN     "changedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "UserSubscription" ADD COLUMN     "watchedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[];

