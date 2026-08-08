-- FeedbackPlan is the only durable workflow/history source from 1.1.1.
ALTER TABLE "FeedbackPlan" ADD COLUMN "inputSnapshot" TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "FeedbackPlan" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "FeedbackPlanItem" ADD COLUMN "generationError" TEXT;

CREATE INDEX "FeedbackPlan_classId_semesterId_archivedAt_updatedAt_idx"
ON "FeedbackPlan"("classId", "semesterId", "archivedAt", "updatedAt");

-- These tables are intentionally retired. WorkHistory is not converted into
-- FeedbackPlan; the backup/verification procedure is the recovery boundary.
DROP TABLE "FeedbackGenerationSelection";
DROP TABLE "WorkHistory";
