-- Formal, privacy-safe history for successful Student Track LLM business results.
CREATE TABLE "GenerationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskType" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL DEFAULT 'hot',
    "semesterId" TEXT,
    "classId" TEXT,
    "sessionId" TEXT,
    "studentId" TEXT,
    "operationKey" TEXT,
    "sourceRefs" TEXT NOT NULL DEFAULT '[]',
    "sourceFingerprint" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelRole" TEXT,
    "modelSettings" TEXT NOT NULL DEFAULT '{}',
    "inputSnapshot" TEXT,
    "outputSnapshot" TEXT,
    "finalText" TEXT,
    "warmSnapshot" TEXT,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adoptedAt" DATETIME,
    "compactedAt" DATETIME,
    "purgedAt" DATETIME,
    "staleAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "TeachingMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "semesterKey" TEXT NOT NULL,
    "semesterId" TEXT,
    "memoryTier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "content" TEXT NOT NULL,
    "sourceRefs" TEXT NOT NULL DEFAULT '[]',
    "sourceFingerprint" TEXT NOT NULL,
    "effectiveThrough" TEXT,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "MemoryCompactionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "classId" TEXT NOT NULL,
    "semesterId" TEXT,
    "fromSessionId" TEXT,
    "toSessionId" TEXT,
    "phase" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sourceFingerprint" TEXT NOT NULL,
    "affectedCount" INTEGER NOT NULL DEFAULT 0,
    "resultJson" TEXT,
    "rollbackPayload" TEXT,
    "undoUntil" DATETIME,
    "failureCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "GenerationRecord_lifecycle_generatedAt_idx" ON "GenerationRecord"("lifecycle", "generatedAt");
CREATE INDEX "GenerationRecord_semesterId_classId_sessionId_idx" ON "GenerationRecord"("semesterId", "classId", "sessionId");
CREATE INDEX "GenerationRecord_studentId_lifecycle_idx" ON "GenerationRecord"("studentId", "lifecycle");
CREATE INDEX "GenerationRecord_taskType_generatedAt_idx" ON "GenerationRecord"("taskType", "generatedAt");
CREATE INDEX "TeachingMemory_scopeType_scopeId_status_idx" ON "TeachingMemory"("scopeType", "scopeId", "status");
CREATE INDEX "TeachingMemory_semesterId_memoryTier_idx" ON "TeachingMemory"("semesterId", "memoryTier");
CREATE UNIQUE INDEX "TeachingMemory_scopeType_scopeId_semesterKey_memoryTier_key" ON "TeachingMemory"("scopeType", "scopeId", "semesterKey", "memoryTier");
CREATE INDEX "MemoryCompactionRun_status_createdAt_idx" ON "MemoryCompactionRun"("status", "createdAt");
CREATE INDEX "MemoryCompactionRun_classId_phase_completedAt_idx" ON "MemoryCompactionRun"("classId", "phase", "completedAt");
CREATE UNIQUE INDEX "MemoryCompactionRun_classId_phase_sourceFingerprint_key" ON "MemoryCompactionRun"("classId", "phase", "sourceFingerprint");
