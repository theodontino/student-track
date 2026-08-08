ALTER TABLE "FeedbackPlan" ADD COLUMN "generationMode" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "FeedbackPlan" ADD COLUMN "generationStartedAt" DATETIME;
ALTER TABLE "FeedbackPlan" ADD COLUMN "generationCompletedAt" DATETIME;
ALTER TABLE "FeedbackPlan" ADD COLUMN "generationElapsedMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FeedbackPlan" ADD COLUMN "generationRunStartedAt" DATETIME;

ALTER TABLE "FeedbackPlanItem" ADD COLUMN "generationStartedAt" DATETIME;
ALTER TABLE "FeedbackPlanItem" ADD COLUMN "generationCompletedAt" DATETIME;
ALTER TABLE "FeedbackPlanItem" ADD COLUMN "generationDurationMs" INTEGER;
