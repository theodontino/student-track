ALTER TABLE "ClassSession" ADD COLUMN "creationRequestKey" TEXT;

ALTER TABLE "ClassSession" ADD COLUMN "creationRequestSnapshot" TEXT;

CREATE UNIQUE INDEX "ClassSession_creationRequestKey_key" ON "ClassSession"("creationRequestKey");
