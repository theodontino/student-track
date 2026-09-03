-- AlterTable
ALTER TABLE "Semester" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "Class" ADD COLUMN "deletedAt" DATETIME;

-- AlterTable
ALTER TABLE "DraftRecord" ADD COLUMN "intakeRunId" TEXT;

-- CreateIndex
CREATE INDEX "Semester_deletedAt_idx" ON "Semester"("deletedAt");

-- CreateIndex
CREATE INDEX "Class_deletedAt_idx" ON "Class"("deletedAt");

-- CreateIndex
CREATE INDEX "DraftRecord_intakeRunId_idx" ON "DraftRecord"("intakeRunId");
