-- Keep the actual communication time separate from the class session used for
-- lineage. WCC evidence may span multiple days while still being attached to
-- one review draft and may therefore not be represented by session.date.
ALTER TABLE "Communication" ADD COLUMN "occurredAt" TEXT NOT NULL DEFAULT '';
ALTER TABLE "CommunicationRevision" ADD COLUMN "previousOccurredAt" TEXT;
ALTER TABLE "CommunicationRevision" ADD COLUMN "nextOccurredAt" TEXT;

DROP INDEX IF EXISTS "Communication_studentId_sessionId_summary_key";
CREATE UNIQUE INDEX "Communication_studentId_sessionId_summary_occurredAt_key"
ON "Communication"("studentId", "sessionId", "summary", "occurredAt");
