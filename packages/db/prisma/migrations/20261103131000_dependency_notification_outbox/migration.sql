CREATE TABLE "DependencyNotificationOutbox" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DependencyNotificationOutbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DependencyNotificationOutbox_createdAt_idx" ON "DependencyNotificationOutbox"("createdAt");

ALTER TABLE "DependencyNotificationOutbox" ADD CONSTRAINT "DependencyNotificationOutbox_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "DependencyProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
