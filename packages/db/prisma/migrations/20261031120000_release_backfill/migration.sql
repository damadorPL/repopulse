-- CreateEnum
CREATE TYPE "BackfillStatus" AS ENUM ('NONE', 'QUEUED', 'RUNNING', 'DONE', 'PARTIAL', 'ERROR');

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "backfillNextPage" INTEGER,
ADD COLUMN     "backfillRequestedAt" TIMESTAMP(3),
ADD COLUMN     "backfillStatus" "BackfillStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "backfillTarget" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "backfilledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Repository_backfillStatus_idx" ON "Repository"("backfillStatus");
