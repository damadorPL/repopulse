-- CreateEnum
CREATE TYPE "ReleaseSource" AS ENUM ('RELEASE', 'TAG');

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "lastTagsPolledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Release" ADD COLUMN     "source" "ReleaseSource" NOT NULL DEFAULT 'RELEASE',
ADD COLUMN     "tagSha" TEXT,
ALTER COLUMN "githubReleaseId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Release_repositoryId_source_tagName_key" ON "Release"("repositoryId", "source", "tagName");

