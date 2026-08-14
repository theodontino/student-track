ALTER TABLE "ClassGroup" ADD COLUMN "leadClassId" TEXT REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ClassGroup_leadClassId_idx" ON "ClassGroup"("leadClassId");
