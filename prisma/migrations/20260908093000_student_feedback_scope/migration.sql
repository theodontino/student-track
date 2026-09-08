-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FeedbackPlan" (
    "structureVersion" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT,
    "basedOnPlanId" TEXT,
    "type" TEXT NOT NULL,
    "outputRequirement" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "semesterId" TEXT NOT NULL,
    "classId" TEXT,
    "sessionId" TEXT,
    "rangeStartSessionId" TEXT,
    "rangeEndSessionId" TEXT,
    "inputFingerprint" TEXT NOT NULL,
    "inputSnapshot" TEXT NOT NULL DEFAULT '{}',
    "generationMode" TEXT NOT NULL DEFAULT 'standard',
    "generationApproach" TEXT NOT NULL DEFAULT 'legacy',
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
INSERT INTO "new_FeedbackPlan" ("approvedAt", "archivedAt", "basedOnPlanId", "batchId", "batchOrder", "classId", "createdAt", "displayName", "exportedAt", "generationApproach", "generationCompletedAt", "generationElapsedMs", "generationMode", "generationRunStartedAt", "generationStartedAt", "id", "inputFingerprint", "inputSnapshot", "outputRequirement", "planRevision", "rangeEndSessionId", "rangeStartSessionId", "semesterId", "sessionId", "status", "type", "updatedAt") SELECT "approvedAt", "archivedAt", "basedOnPlanId", "batchId", "batchOrder", "classId", "createdAt", "displayName", "exportedAt", "generationApproach", "generationCompletedAt", "generationElapsedMs", "generationMode", "generationRunStartedAt", "generationStartedAt", "id", "inputFingerprint", "inputSnapshot", "outputRequirement", "planRevision", "rangeEndSessionId", "rangeStartSessionId", "semesterId", "sessionId", "status", "type", "updatedAt" FROM "FeedbackPlan";
DROP TABLE "FeedbackPlan";
ALTER TABLE "new_FeedbackPlan" RENAME TO "FeedbackPlan";
CREATE INDEX "FeedbackPlan_basedOnPlanId_idx" ON "FeedbackPlan"("basedOnPlanId");
CREATE INDEX "FeedbackPlan_classId_semesterId_archivedAt_updatedAt_idx" ON "FeedbackPlan"("classId", "semesterId", "archivedAt", "updatedAt");
CREATE INDEX "FeedbackPlan_classId_semesterId_type_createdAt_idx" ON "FeedbackPlan"("classId", "semesterId", "type", "createdAt");
CREATE INDEX "FeedbackPlan_status_updatedAt_idx" ON "FeedbackPlan"("status", "updatedAt");
CREATE UNIQUE INDEX "FeedbackPlan_batchId_batchOrder_key" ON "FeedbackPlan"("batchId", "batchOrder");
CREATE UNIQUE INDEX "FeedbackPlan_batchId_classId_key" ON "FeedbackPlan"("batchId", "classId");
CREATE TABLE "new_FeedbackPlanItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "studentId" TEXT,
    "classId" TEXT,
    "sessionId" TEXT,
    "contextSnapshot" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'evidence_ready',
    "generationError" TEXT,
    "generationConfigSnapshot" TEXT NOT NULL DEFAULT '{}',
    "generationExecutionSnapshot" TEXT NOT NULL DEFAULT '{}',
    "evidenceSnapshot" TEXT NOT NULL DEFAULT '{}',
    "compositionSnapshot" TEXT NOT NULL DEFAULT '{}',
    "auditSnapshot" TEXT NOT NULL DEFAULT '{}',
    "finalText" TEXT,
    "finalTextHash" TEXT,
    "selectedGenerationId" TEXT,
    "reviewMode" TEXT NOT NULL DEFAULT 'model',
    "generationStartedAt" DATETIME,
    "generationCompletedAt" DATETIME,
    "generationDurationMs" INTEGER,
    "itemRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "approvedAt" DATETIME,
    "exportedAt" DATETIME,
    CONSTRAINT "FeedbackPlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FeedbackPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlanItem_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlanItem_selectedGenerationId_fkey" FOREIGN KEY ("selectedGenerationId") REFERENCES "GenerationRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FeedbackPlanItem" ("approvedAt", "auditSnapshot", "compositionSnapshot", "createdAt", "evidenceSnapshot", "exportedAt", "finalText", "finalTextHash", "generationCompletedAt", "generationConfigSnapshot", "generationDurationMs", "generationError", "generationExecutionSnapshot", "generationStartedAt", "id", "itemRevision", "planId", "reviewMode", "selectedGenerationId", "status", "studentId", "updatedAt") SELECT "approvedAt", "auditSnapshot", "compositionSnapshot", "createdAt", "evidenceSnapshot", "exportedAt", "finalText", "finalTextHash", "generationCompletedAt", "generationConfigSnapshot", "generationDurationMs", "generationError", "generationExecutionSnapshot", "generationStartedAt", "id", "itemRevision", "planId", "reviewMode", "selectedGenerationId", "status", "studentId", "updatedAt" FROM "FeedbackPlanItem";
DROP TABLE "FeedbackPlanItem";
ALTER TABLE "new_FeedbackPlanItem" RENAME TO "FeedbackPlanItem";
CREATE INDEX "FeedbackPlanItem_studentId_status_idx" ON "FeedbackPlanItem"("studentId", "status");
CREATE INDEX "FeedbackPlanItem_classId_sessionId_idx" ON "FeedbackPlanItem"("classId", "sessionId");
CREATE INDEX "FeedbackPlanItem_selectedGenerationId_idx" ON "FeedbackPlanItem"("selectedGenerationId");
CREATE UNIQUE INDEX "FeedbackPlanItem_planId_studentId_key" ON "FeedbackPlanItem"("planId", "studentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

