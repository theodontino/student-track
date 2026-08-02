-- Feedback plan, composition, commitment and export ledger.
ALTER TABLE "GenerationRecord" ADD COLUMN "feedbackPlanItemId" TEXT;

CREATE TABLE "FeedbackPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "semesterId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "sessionId" TEXT,
    "rangeStartSessionId" TEXT,
    "rangeEndSessionId" TEXT,
    "inputFingerprint" TEXT NOT NULL,
    "planRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "approvedAt" DATETIME,
    "exportedAt" DATETIME,
    CONSTRAINT "FeedbackPlan_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_rangeStartSessionId_fkey" FOREIGN KEY ("rangeStartSessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlan_rangeEndSessionId_fkey" FOREIGN KEY ("rangeEndSessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "FeedbackPlanItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "studentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'evidence_ready',
    "evidenceSnapshot" TEXT NOT NULL DEFAULT '{}',
    "compositionSnapshot" TEXT NOT NULL DEFAULT '{}',
    "auditSnapshot" TEXT NOT NULL DEFAULT '{}',
    "finalText" TEXT,
    "finalTextHash" TEXT,
    "selectedGenerationId" TEXT,
    "reviewMode" TEXT NOT NULL DEFAULT 'model',
    "itemRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "approvedAt" DATETIME,
    "exportedAt" DATETIME,
    CONSTRAINT "FeedbackPlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FeedbackPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlanItem_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackPlanItem_selectedGenerationId_fkey" FOREIGN KEY ("selectedGenerationId") REFERENCES "GenerationRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "TeacherTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "planItemId" TEXT,
    "studentId" TEXT,
    "classId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "promiseExcerpt" TEXT,
    "dueType" TEXT NOT NULL,
    "dueDate" TEXT,
    "dueSessionId" TEXT,
    "estimatedMinutes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sourceHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" DATETIME,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TeacherTask_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FeedbackPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeacherTask_planItemId_fkey" FOREIGN KEY ("planItemId") REFERENCES "FeedbackPlanItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TeacherTask_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeacherTask_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeacherTask_dueSessionId_fkey" FOREIGN KEY ("dueSessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "CommunicationPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "preferenceSnapshot" TEXT NOT NULL DEFAULT '{}',
    "sourceCandidateId" TEXT,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CommunicationPreference_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CommunicationPreference_sourceCandidateId_fkey" FOREIGN KEY ("sourceCandidateId") REFERENCES "CommunicationPreferenceCandidate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "CommunicationPreferenceCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "preferenceSnapshot" TEXT NOT NULL DEFAULT '{}',
    "evidenceSnapshot" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    CONSTRAINT "CommunicationPreferenceCandidate_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "FeedbackAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "planItemId" TEXT,
    "displayName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "relativeLocator" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "FeedbackAttachment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FeedbackPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedbackAttachment_planItemId_fkey" FOREIGN KEY ("planItemId") REFERENCES "FeedbackPlanItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "FeedbackExportRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "itemManifest" TEXT NOT NULL DEFAULT '[]',
    "manifestHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeedbackExportRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "FeedbackPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "FeedbackPlan_classId_semesterId_type_createdAt_idx" ON "FeedbackPlan"("classId", "semesterId", "type", "createdAt");
CREATE INDEX "FeedbackPlan_status_updatedAt_idx" ON "FeedbackPlan"("status", "updatedAt");
CREATE UNIQUE INDEX "FeedbackPlanItem_planId_studentId_key" ON "FeedbackPlanItem"("planId", "studentId");
CREATE INDEX "FeedbackPlanItem_studentId_status_idx" ON "FeedbackPlanItem"("studentId", "status");
CREATE INDEX "FeedbackPlanItem_selectedGenerationId_idx" ON "FeedbackPlanItem"("selectedGenerationId");
CREATE INDEX "TeacherTask_status_dueDate_idx" ON "TeacherTask"("status", "dueDate");
CREATE INDEX "TeacherTask_status_dueSessionId_idx" ON "TeacherTask"("status", "dueSessionId");
CREATE INDEX "TeacherTask_studentId_status_idx" ON "TeacherTask"("studentId", "status");
CREATE UNIQUE INDEX "CommunicationPreference_studentId_key" ON "CommunicationPreference"("studentId");
CREATE UNIQUE INDEX "CommunicationPreference_sourceCandidateId_key" ON "CommunicationPreference"("sourceCandidateId");
CREATE INDEX "CommunicationPreference_updatedAt_idx" ON "CommunicationPreference"("updatedAt");
CREATE INDEX "CommunicationPreferenceCandidate_studentId_status_createdAt_idx" ON "CommunicationPreferenceCandidate"("studentId", "status", "createdAt");
CREATE INDEX "FeedbackAttachment_planId_status_idx" ON "FeedbackAttachment"("planId", "status");
CREATE INDEX "FeedbackAttachment_sha256_idx" ON "FeedbackAttachment"("sha256");
CREATE INDEX "FeedbackExportRun_planId_createdAt_idx" ON "FeedbackExportRun"("planId", "createdAt");
CREATE INDEX "GenerationRecord_feedbackPlanItemId_idx" ON "GenerationRecord"("feedbackPlanItemId");

DROP INDEX IF EXISTS "communication_student_session_summary_key";
CREATE UNIQUE INDEX "Communication_studentId_sessionId_summary_key" ON "Communication"("studentId", "sessionId", "summary");
