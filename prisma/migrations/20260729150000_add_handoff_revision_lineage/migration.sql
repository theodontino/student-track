-- AlterTable
ALTER TABLE "DraftRecord" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "DraftRecord" ADD COLUMN "supersedesDraftId" TEXT REFERENCES "DraftRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DraftRecord" ADD COLUMN "communicationId" TEXT REFERENCES "Communication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DraftRecord" ADD COLUMN "handoffPackageId" TEXT REFERENCES "WeComHandoffPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "WeComHandoffPackage" ADD COLUMN "rootPackageId" TEXT;
ALTER TABLE "WeComHandoffPackage" ADD COLUMN "parentPackageId" TEXT;
ALTER TABLE "WeComHandoffPackage" ADD COLUMN "revisionNumber" INTEGER NOT NULL DEFAULT 1;
UPDATE "WeComHandoffPackage" SET "rootPackageId" = "packageId" WHERE "rootPackageId" IS NULL;

-- CreateTable
CREATE TABLE "CommunicationRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "communicationId" TEXT NOT NULL,
    "draftId" TEXT,
    "handoffPackageId" TEXT,
    "previousTarget" TEXT NOT NULL,
    "nextTarget" TEXT NOT NULL,
    "previousSummary" TEXT NOT NULL,
    "nextSummary" TEXT NOT NULL,
    "previousSessionId" TEXT NOT NULL,
    "nextSessionId" TEXT NOT NULL,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunicationRevision_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "Communication" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CommunicationRevision_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "DraftRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CommunicationRevision_handoffPackageId_fkey" FOREIGN KEY ("handoffPackageId") REFERENCES "WeComHandoffPackage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DraftRecord_supersedesDraftId_idx" ON "DraftRecord"("supersedesDraftId");
CREATE INDEX "DraftRecord_communicationId_idx" ON "DraftRecord"("communicationId");
CREATE INDEX "DraftRecord_handoffPackageId_idx" ON "DraftRecord"("handoffPackageId");
CREATE INDEX "WeComHandoffPackage_rootPackageId_revisionNumber_idx" ON "WeComHandoffPackage"("rootPackageId", "revisionNumber");
CREATE INDEX "WeComHandoffPackage_parentPackageId_idx" ON "WeComHandoffPackage"("parentPackageId");
CREATE UNIQUE INDEX "CommunicationRevision_communicationId_draftId_key" ON "CommunicationRevision"("communicationId", "draftId");
CREATE INDEX "CommunicationRevision_communicationId_confirmedAt_idx" ON "CommunicationRevision"("communicationId", "confirmedAt");
CREATE INDEX "CommunicationRevision_handoffPackageId_idx" ON "CommunicationRevision"("handoffPackageId");
