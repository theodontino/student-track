CREATE TABLE "WeComHandoffPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "packageSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outcome" TEXT,
    "code" TEXT,
    "messageCount" INTEGER NOT NULL,
    "selectedStudentId" TEXT,
    "receiptId" TEXT,
    "producedAt" DATETIME NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" DATETIME,
    "processedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WeComHandoffPackage_selectedStudentId_fkey"
      FOREIGN KEY ("selectedStudentId") REFERENCES "Student" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WeComHandoffPackage_sourceId_packageId_packageSha256_key"
ON "WeComHandoffPackage"("sourceId", "packageId", "packageSha256");

CREATE INDEX "WeComHandoffPackage_sourceId_packageId_idx"
ON "WeComHandoffPackage"("sourceId", "packageId");

CREATE INDEX "WeComHandoffPackage_status_updatedAt_idx"
ON "WeComHandoffPackage"("status", "updatedAt");

CREATE INDEX "WeComHandoffPackage_selectedStudentId_idx"
ON "WeComHandoffPackage"("selectedStudentId");
