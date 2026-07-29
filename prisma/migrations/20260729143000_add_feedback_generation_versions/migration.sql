-- AlterTable
ALTER TABLE "GenerationRecord" ADD COLUMN "modelProfileId" TEXT;
ALTER TABLE "GenerationRecord" ADD COLUMN "inputRevision" TEXT;
ALTER TABLE "GenerationRecord" ADD COLUMN "parentGenerationId" TEXT REFERENCES "GenerationRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GenerationRecord" ADD COLUMN "variantKey" TEXT;

-- CreateTable
CREATE TABLE "FeedbackGenerationSelection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "selectedGenerationId" TEXT NOT NULL,
    "selectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FeedbackGenerationSelection_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackGenerationSelection_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackGenerationSelection_selectedGenerationId_fkey" FOREIGN KEY ("selectedGenerationId") REFERENCES "GenerationRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "GenerationRecord_variantKey_key" ON "GenerationRecord"("variantKey");
CREATE INDEX "GenerationRecord_parentGenerationId_idx" ON "GenerationRecord"("parentGenerationId");
CREATE INDEX "GenerationRecord_inputRevision_idx" ON "GenerationRecord"("inputRevision");
CREATE UNIQUE INDEX "FeedbackGenerationSelection_sessionId_studentId_key" ON "FeedbackGenerationSelection"("sessionId", "studentId");
CREATE INDEX "FeedbackGenerationSelection_selectedGenerationId_idx" ON "FeedbackGenerationSelection"("selectedGenerationId");
