ALTER TABLE "Communication" ADD COLUMN "sourceKey" TEXT;

CREATE UNIQUE INDEX "Communication_sourceKey_key" ON "Communication"("sourceKey");

CREATE TABLE "WeComImportState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "initializedAfter" DATETIME NOT NULL,
    "lastSucceededUntil" DATETIME,
    "activeRunId" TEXT,
    "activeRunStartedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "WeComImportRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "windowStartedAt" DATETIME NOT NULL,
    "windowEndedAt" DATETIME NOT NULL,
    "conversationCount" INTEGER NOT NULL DEFAULT 0,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "batchCount" INTEGER NOT NULL DEFAULT 0,
    "communicationCount" INTEGER NOT NULL DEFAULT 0,
    "labelCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "rolledBackAt" DATETIME
);

CREATE TABLE "WeComImportOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "batchKey" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "conversationTitle" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "candidateStudentIds" TEXT NOT NULL DEFAULT '[]',
    "communicationCount" INTEGER NOT NULL DEFAULT 0,
    "labelCount" INTEGER NOT NULL DEFAULT 0,
    "candidateJson" TEXT,
    "extractedAt" DATETIME,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "rolledBackAt" DATETIME,
    CONSTRAINT "WeComImportOperation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WeComImportRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WeComMessageReceipt" (
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sentAt" DATETIME,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "operationId" TEXT,
    "processedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("conversationId", "messageId"),
    CONSTRAINT "WeComMessageReceipt_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "WeComImportOperation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "WeComImportChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operationId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "studentId" TEXT,
    "labelId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WeComImportChange_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "WeComImportOperation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WeComImportRun_status_startedAt_idx" ON "WeComImportRun"("status", "startedAt");
CREATE UNIQUE INDEX "WeComImportOperation_runId_batchKey_key" ON "WeComImportOperation"("runId", "batchKey");
CREATE INDEX "WeComImportOperation_runId_status_idx" ON "WeComImportOperation"("runId", "status");
CREATE INDEX "WeComImportOperation_status_completedAt_idx" ON "WeComImportOperation"("status", "completedAt");
CREATE INDEX "WeComImportOperation_conversationId_idx" ON "WeComImportOperation"("conversationId");
CREATE INDEX "WeComMessageReceipt_conversationId_status_idx" ON "WeComMessageReceipt"("conversationId", "status");
CREATE INDEX "WeComMessageReceipt_status_updatedAt_idx" ON "WeComMessageReceipt"("status", "updatedAt");
CREATE UNIQUE INDEX "WeComImportChange_operationId_entityType_entityId_key" ON "WeComImportChange"("operationId", "entityType", "entityId");
CREATE INDEX "WeComImportChange_operationId_idx" ON "WeComImportChange"("operationId");
