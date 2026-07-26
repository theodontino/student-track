CREATE TABLE "TeachingSummaryCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "includeCommunications" BOOLEAN NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "TeachingSummaryCache_scopeType_scopeKey_includeCommunications_key"
ON "TeachingSummaryCache"("scopeType", "scopeKey", "includeCommunications");
CREATE INDEX "TeachingSummaryCache_generatedAt_idx" ON "TeachingSummaryCache"("generatedAt");

CREATE TABLE "TeacherObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "evidenceSummary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "analysisVersion" TEXT NOT NULL,
    "firstDetectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusChangedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeacherObservation_studentId_fkey"
      FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TeacherObservation_studentId_kind_topic_key"
ON "TeacherObservation"("studentId", "kind", "topic");
CREATE INDEX "TeacherObservation_status_lastDetectedAt_idx"
ON "TeacherObservation"("status", "lastDetectedAt");
CREATE INDEX "TeacherObservation_studentId_idx" ON "TeacherObservation"("studentId");

CREATE TABLE "TeacherObservationSource" (
    "observationId" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "relatedSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("observationId", "communicationId"),
    CONSTRAINT "TeacherObservationSource_observationId_fkey"
      FOREIGN KEY ("observationId") REFERENCES "TeacherObservation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeacherObservationSource_communicationId_fkey"
      FOREIGN KEY ("communicationId") REFERENCES "Communication" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeacherObservationSource_relatedSessionId_fkey"
      FOREIGN KEY ("relatedSessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "TeacherObservationSource_communicationId_idx"
ON "TeacherObservationSource"("communicationId");
CREATE INDEX "TeacherObservationSource_relatedSessionId_idx"
ON "TeacherObservationSource"("relatedSessionId");
