ALTER TABLE "WeComHandoffPackage" ADD COLUMN "conversationId" TEXT;

CREATE INDEX "WeComHandoffPackage_sourceId_conversationId_idx"
ON "WeComHandoffPackage"("sourceId", "conversationId");
