-- beta.3 could persist a planning-only row as "ready" even though no
-- generation had ever started. Record the provably untouched plans first so
-- batch eligibility is evaluated before child statuses change.
CREATE TEMP TABLE "_Issue64NeverGeneratedFeedbackPlan" AS
SELECT "p"."id"
FROM "FeedbackPlan" AS "p"
WHERE "p"."status" = 'ready'
  AND "p"."generationStartedAt" IS NULL
  AND "p"."generationCompletedAt" IS NULL
  AND "p"."generationRunStartedAt" IS NULL
  AND COALESCE("p"."generationElapsedMs", 0) = 0
  AND "p"."approvedAt" IS NULL
  AND "p"."exportedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "FeedbackPlanItem" AS "item"
    WHERE "item"."planId" = "p"."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "FeedbackExportRun" AS "exportRun"
    WHERE "exportRun"."planId" = "p"."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "FeedbackPlanItem" AS "item"
    WHERE "item"."planId" = "p"."id"
      AND (
        "item"."status" <> 'evidence_ready'
        OR "item"."generationError" IS NOT NULL
        OR TRIM(COALESCE("item"."generationExecutionSnapshot", '')) <> '{}'
        OR TRIM(COALESCE("item"."compositionSnapshot", '')) <> '{}'
        OR TRIM(COALESCE("item"."auditSnapshot", '')) <> '{}'
        OR "item"."finalText" IS NOT NULL
        OR "item"."finalTextHash" IS NOT NULL
        OR "item"."selectedGenerationId" IS NOT NULL
        OR "item"."reviewMode" <> 'model'
        OR "item"."generationStartedAt" IS NOT NULL
        OR "item"."generationCompletedAt" IS NOT NULL
        OR "item"."generationDurationMs" IS NOT NULL
        OR "item"."approvedAt" IS NOT NULL
        OR "item"."exportedAt" IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM "GenerationRecord" AS "generation"
          WHERE "generation"."feedbackPlanItemId" = "item"."id"
        )
      )
  );

UPDATE "FeedbackPlanBatch"
SET "status" = 'draft'
WHERE "status" = 'ready'
  AND "currentPlanId" IS NULL
  AND "failedPlanId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "FeedbackPlanBatchExportRun" AS "exportRun"
    WHERE "exportRun"."batchId" = "FeedbackPlanBatch"."id"
  )
  AND EXISTS (
    SELECT 1 FROM "FeedbackPlan" AS "child"
    WHERE "child"."batchId" = "FeedbackPlanBatch"."id"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "FeedbackPlan" AS "child"
    WHERE "child"."batchId" = "FeedbackPlanBatch"."id"
      AND NOT EXISTS (
        SELECT 1
        FROM "_Issue64NeverGeneratedFeedbackPlan" AS "eligible"
        WHERE "eligible"."id" = "child"."id"
      )
  );

UPDATE "FeedbackPlan"
SET "status" = 'draft'
WHERE "id" IN (SELECT "id" FROM "_Issue64NeverGeneratedFeedbackPlan");

DROP TABLE "_Issue64NeverGeneratedFeedbackPlan";
