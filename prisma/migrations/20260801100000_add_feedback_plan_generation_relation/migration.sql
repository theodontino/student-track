-- Connect each feedback-plan generation record to its owning plan item.
-- This is a follow-up migration because 20260731150000 may already be applied locally.
PRAGMA foreign_keys=OFF;

CREATE TABLE "GenerationRecord_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskType" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL DEFAULT 'hot',
    "semesterId" TEXT,
    "classId" TEXT,
    "sessionId" TEXT,
    "studentId" TEXT,
    "operationKey" TEXT,
    "sourceRefs" TEXT NOT NULL DEFAULT '[]',
    "sourceFingerprint" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelRole" TEXT,
    "modelProfileId" TEXT,
    "modelSettings" TEXT NOT NULL DEFAULT '{}',
    "inputRevision" TEXT,
    "parentGenerationId" TEXT,
    "feedbackPlanItemId" TEXT,
    "variantKey" TEXT,
    "inputSnapshot" TEXT,
    "outputSnapshot" TEXT,
    "finalText" TEXT,
    "warmSnapshot" TEXT,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adoptedAt" DATETIME,
    "compactedAt" DATETIME,
    "purgedAt" DATETIME,
    "staleAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GenerationRecord_new_parentGenerationId_fkey" FOREIGN KEY ("parentGenerationId") REFERENCES "GenerationRecord_new" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "GenerationRecord_new_feedbackPlanItemId_fkey" FOREIGN KEY ("feedbackPlanItemId") REFERENCES "FeedbackPlanItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "GenerationRecord_new" (
  "id", "taskType", "stage", "lifecycle", "semesterId", "classId", "sessionId", "studentId", "operationKey",
  "sourceRefs", "sourceFingerprint", "promptVersion", "modelName", "modelRole", "modelProfileId", "modelSettings",
  "inputRevision", "parentGenerationId", "feedbackPlanItemId", "variantKey", "inputSnapshot", "outputSnapshot", "finalText",
  "warmSnapshot", "generatedAt", "adoptedAt", "compactedAt", "purgedAt", "staleAt", "createdAt", "updatedAt"
)
SELECT
  "id", "taskType", "stage", "lifecycle", "semesterId", "classId", "sessionId", "studentId", "operationKey",
  "sourceRefs", "sourceFingerprint", "promptVersion", "modelName", "modelRole", "modelProfileId", "modelSettings",
  "inputRevision", "parentGenerationId", "feedbackPlanItemId", "variantKey", "inputSnapshot", "outputSnapshot", "finalText",
  "warmSnapshot", "generatedAt", "adoptedAt", "compactedAt", "purgedAt", "staleAt", "createdAt", "updatedAt"
FROM "GenerationRecord";

DROP TABLE "GenerationRecord";
ALTER TABLE "GenerationRecord_new" RENAME TO "GenerationRecord";

CREATE UNIQUE INDEX "GenerationRecord_variantKey_key" ON "GenerationRecord"("variantKey");
CREATE INDEX "GenerationRecord_lifecycle_generatedAt_idx" ON "GenerationRecord"("lifecycle", "generatedAt");
CREATE INDEX "GenerationRecord_semesterId_classId_sessionId_idx" ON "GenerationRecord"("semesterId", "classId", "sessionId");
CREATE INDEX "GenerationRecord_studentId_lifecycle_idx" ON "GenerationRecord"("studentId", "lifecycle");
CREATE INDEX "GenerationRecord_taskType_generatedAt_idx" ON "GenerationRecord"("taskType", "generatedAt");
CREATE INDEX "GenerationRecord_parentGenerationId_idx" ON "GenerationRecord"("parentGenerationId");
CREATE INDEX "GenerationRecord_inputRevision_idx" ON "GenerationRecord"("inputRevision");
CREATE INDEX "GenerationRecord_feedbackPlanItemId_idx" ON "GenerationRecord"("feedbackPlanItemId");

PRAGMA foreign_keys=ON;
