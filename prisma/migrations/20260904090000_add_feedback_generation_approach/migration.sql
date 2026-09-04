ALTER TABLE "FeedbackPlan" ADD COLUMN "generationApproach" TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE "FeedbackPlanBatch" ADD COLUMN "generationApproach" TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE "FeedbackPlanItem" ADD COLUMN "generationExecutionSnapshot" TEXT NOT NULL DEFAULT '{}';
