-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FeedbackPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT,
    "basedOnPlanId" TEXT,
    "type" TEXT NOT NULL,
    "outputRequirement" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "semesterId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "sessionId" TEXT,
    "rangeStartSessionId" TEXT,
    "rangeEndSessionId" TEXT,
    "inputFingerprint" TEXT NOT NULL,
    "inputSnapshot" TEXT NOT NULL DEFAULT '{}',
    "generationMode" TEXT NOT NULL DEFAULT 'standard',
    "generationStartedAt" DATETIME,
    "generationCompletedAt" DATETIME,
    "generationElapsedMs" INTEGER NOT NULL DEFAULT 0,
    "generationRunStartedAt" DATETIME,
    "planRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "approvedAt" DATETIME,
    "exportedAt" DATETIME,
    "archivedAt" DATETIME,
    "batchId" TEXT,
    "batchOrder" INTEGER,
    CONSTRAINT "FeedbackPlan_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_rangeStartSessionId_fkey" FOREIGN KEY ("rangeStartSessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_rangeEndSessionId_fkey" FOREIGN KEY ("rangeEndSessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "FeedbackPlanBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_basedOnPlanId_fkey" FOREIGN KEY ("basedOnPlanId") REFERENCES "FeedbackPlan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FeedbackPlan" ("approvedAt", "archivedAt", "batchId", "batchOrder", "classId", "createdAt", "exportedAt", "generationCompletedAt", "generationElapsedMs", "generationMode", "generationRunStartedAt", "generationStartedAt", "id", "inputFingerprint", "inputSnapshot", "outputRequirement", "planRevision", "rangeEndSessionId", "rangeStartSessionId", "semesterId", "sessionId", "status", "type", "updatedAt") SELECT "approvedAt", "archivedAt", "batchId", "batchOrder", "classId", "createdAt", "exportedAt", "generationCompletedAt", "generationElapsedMs", "generationMode", "generationRunStartedAt", "generationStartedAt", "id", "inputFingerprint", "inputSnapshot", "outputRequirement", "planRevision", "rangeEndSessionId", "rangeStartSessionId", "semesterId", "sessionId", "status", "type", "updatedAt" FROM "FeedbackPlan";
DROP TABLE "FeedbackPlan";
ALTER TABLE "new_FeedbackPlan" RENAME TO "FeedbackPlan";
CREATE INDEX "FeedbackPlan_basedOnPlanId_idx" ON "FeedbackPlan"("basedOnPlanId");
CREATE INDEX "FeedbackPlan_classId_semesterId_archivedAt_updatedAt_idx" ON "FeedbackPlan"("classId", "semesterId", "archivedAt", "updatedAt");
CREATE INDEX "FeedbackPlan_classId_semesterId_type_createdAt_idx" ON "FeedbackPlan"("classId", "semesterId", "type", "createdAt");
CREATE INDEX "FeedbackPlan_status_updatedAt_idx" ON "FeedbackPlan"("status", "updatedAt");
CREATE UNIQUE INDEX "FeedbackPlan_batchId_batchOrder_key" ON "FeedbackPlan"("batchId", "batchOrder");
CREATE UNIQUE INDEX "FeedbackPlan_batchId_classId_key" ON "FeedbackPlan"("batchId", "classId");
CREATE TABLE "new_FeedbackPlanBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT,
    "basedOnBatchId" TEXT,
    "requestKey" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outputRequirement" TEXT NOT NULL,
    "generationMode" TEXT NOT NULL DEFAULT 'standard',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currentPlanId" TEXT,
    "failedPlanId" TEXT,
    "sharedLessonRevisionId" TEXT,
    "planRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    CONSTRAINT "FeedbackPlanBatch_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlanBatch_sharedLessonRevisionId_fkey" FOREIGN KEY ("sharedLessonRevisionId") REFERENCES "GroupLessonRevision" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlanBatch_basedOnBatchId_fkey" FOREIGN KEY ("basedOnBatchId") REFERENCES "FeedbackPlanBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FeedbackPlanBatch" ("archivedAt", "createdAt", "currentPlanId", "failedPlanId", "generationMode", "id", "outputRequirement", "planRevision", "requestKey", "semesterId", "sharedLessonRevisionId", "status", "type", "updatedAt") SELECT "archivedAt", "createdAt", "currentPlanId", "failedPlanId", "generationMode", "id", "outputRequirement", "planRevision", "requestKey", "semesterId", "sharedLessonRevisionId", "status", "type", "updatedAt" FROM "FeedbackPlanBatch";
DROP TABLE "FeedbackPlanBatch";
ALTER TABLE "new_FeedbackPlanBatch" RENAME TO "FeedbackPlanBatch";
CREATE UNIQUE INDEX "FeedbackPlanBatch_requestKey_key" ON "FeedbackPlanBatch"("requestKey");
CREATE INDEX "FeedbackPlanBatch_basedOnBatchId_idx" ON "FeedbackPlanBatch"("basedOnBatchId");
CREATE INDEX "FeedbackPlanBatch_semesterId_archivedAt_updatedAt_idx" ON "FeedbackPlanBatch"("semesterId", "archivedAt", "updatedAt");
CREATE INDEX "FeedbackPlanBatch_status_updatedAt_idx" ON "FeedbackPlanBatch"("status", "updatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
