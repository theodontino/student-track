-- CreateTable
CREATE TABLE "FeedbackIntakeRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionCode" TEXT NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "sourceManifest" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'ready',
    "appliedSummary" TEXT NOT NULL DEFAULT '{}',
    "issues" TEXT NOT NULL DEFAULT '[]',
    "planId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FeedbackIntakeRun_sessionCode_fkey" FOREIGN KEY ("sessionCode") REFERENCES "ClassSession" ("code") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackIntakeRun_sourceFingerprint_key" ON "FeedbackIntakeRun"("sourceFingerprint");
CREATE INDEX "FeedbackIntakeRun_sessionCode_createdAt_idx" ON "FeedbackIntakeRun"("sessionCode", "createdAt");
CREATE INDEX "FeedbackIntakeRun_status_updatedAt_idx" ON "FeedbackIntakeRun"("status", "updatedAt");
