CREATE TABLE "DependencyBranchWriteIntent" (
    "projectId" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "previousHeadSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DependencyBranchWriteIntent_pkey" PRIMARY KEY ("projectId", "groupKey")
);

ALTER TABLE "DependencyBranchWriteIntent" ADD CONSTRAINT "DependencyBranchWriteIntent_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "DependencyProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
