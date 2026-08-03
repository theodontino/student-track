-- Class is now a semester-scoped entity. Existing class rows are split only
-- when the same legacy class was used by more than one semester. Student
-- remains a stable profile; the per-semester roster lives in Enrollment.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TEMP TABLE "_CurrentSemester" AS
SELECT "id"
FROM "Semester"
ORDER BY CASE
  WHEN "startDate" <= date('now') AND "endDate" >= date('now') THEN 0
  ELSE 1
END, "startDate" DESC, "id" DESC
LIMIT 1;

-- A legacy database with classes but no semester cannot be upgraded safely.
-- Force the migration to abort before any table is rebuilt instead of
-- silently dropping those classes.
CREATE TEMP TABLE "_MigrationGuard" ("id" INTEGER);
CREATE TEMP TRIGGER "_MigrationGuard_validate"
BEFORE INSERT ON "_MigrationGuard"
WHEN EXISTS (SELECT 1 FROM "Class") AND NOT EXISTS (SELECT 1 FROM "_CurrentSemester")
BEGIN
  SELECT RAISE(ABORT, 'Student Track migration requires a semester before class migration');
END;
INSERT INTO "_MigrationGuard" VALUES (1);
DROP TRIGGER "_MigrationGuard_validate";
DROP TABLE "_MigrationGuard";

CREATE TEMP TABLE "_ClassSemesterPairs" (
  "oldClassId" TEXT NOT NULL,
  "semesterId" TEXT NOT NULL,
  PRIMARY KEY ("oldClassId", "semesterId")
);

INSERT OR IGNORE INTO "_ClassSemesterPairs" ("oldClassId", "semesterId")
SELECT "classId", "semesterId"
FROM "ClassSession"
WHERE "classId" IS NOT NULL;

INSERT OR IGNORE INTO "_ClassSemesterPairs" ("oldClassId", "semesterId")
SELECT "classId", "semesterId"
FROM "FeedbackPlan";

INSERT OR IGNORE INTO "_ClassSemesterPairs" ("oldClassId", "semesterId")
SELECT "classId", "semesterId"
FROM "GenerationRecord"
WHERE "classId" IS NOT NULL AND "semesterId" IS NOT NULL;

INSERT OR IGNORE INTO "_ClassSemesterPairs" ("oldClassId", "semesterId")
SELECT "classId", "semesterId"
FROM "MemoryCompactionRun"
WHERE "semesterId" IS NOT NULL;

INSERT OR IGNORE INTO "_ClassSemesterPairs" ("oldClassId", "semesterId")
SELECT memory."scopeId", memory."semesterId"
FROM "TeachingMemory" memory
JOIN "Class" class ON class."id" = memory."scopeId"
WHERE memory."scopeType" = 'class' AND memory."semesterId" IS NOT NULL;

-- The legacy global roster is authoritative for the current term when that
-- student has no current-term evidence yet. Add this pair even when the same
-- class already has historical activity, so the current roster is not lost.
INSERT OR IGNORE INTO "_ClassSemesterPairs" ("oldClassId", "semesterId")
SELECT DISTINCT student."classId", current."id"
FROM "Student" student
JOIN "_CurrentSemester" current
JOIN "Class" class ON class."id" = student."classId";

-- Classes that were created from a roster before their first session are
-- assigned to the same resolved current semester used by the application.
INSERT OR IGNORE INTO "_ClassSemesterPairs" ("oldClassId", "semesterId")
SELECT c."id", (SELECT "id" FROM "_CurrentSemester")
FROM "Class" c
WHERE NOT EXISTS (
  SELECT 1 FROM "_ClassSemesterPairs" p WHERE p."oldClassId" = c."id"
)
AND (SELECT "id" FROM "_CurrentSemester") IS NOT NULL;

CREATE TEMP TABLE "_ClassSemesterMap" AS
WITH ranked AS (
  SELECT
    p."oldClassId",
    p."semesterId",
    ROW_NUMBER() OVER (
      PARTITION BY p."oldClassId"
      ORDER BY s."startDate" DESC, s."id" DESC
    ) AS "rank"
  FROM "_ClassSemesterPairs" p
  JOIN "Semester" s ON s."id" = p."semesterId"
)
SELECT
  "oldClassId",
  "semesterId",
  CASE
    WHEN "rank" = 1 THEN "oldClassId"
    ELSE "oldClassId" || '--' || "semesterId"
  END AS "newClassId",
  CASE WHEN "rank" = 1 THEN 1 ELSE 0 END AS "isPrimary"
FROM ranked;

CREATE TEMP TABLE "_LegacyStudentRoster" AS
SELECT "id", "classId", "rosterStatus", "statusEffectiveAt"
FROM "Student";

CREATE TEMP TABLE "_StudentTermClassCandidates" AS
SELECT "studentId", "semesterId", "classId", MAX("date") AS "lastDate"
FROM (
  SELECT a."studentId", s."semesterId", s."classId", s."date"
  FROM "Attendance" a
  JOIN "ClassSession" s ON s."id" = a."sessionId"
  WHERE s."classId" IS NOT NULL
  UNION ALL
  SELECT m."studentId", s."semesterId", s."classId", s."date"
  FROM "SessionMetric" m
  JOIN "ClassSession" s ON s."id" = m."sessionId"
  WHERE s."classId" IS NOT NULL
  UNION ALL
  SELECT e."studentId", s."semesterId", s."classId", s."date"
  FROM "Event" e
  JOIN "ClassSession" s ON s."id" = e."sessionId"
  WHERE s."classId" IS NOT NULL
  UNION ALL
  SELECT c."studentId", s."semesterId", s."classId", s."date"
  FROM "Communication" c
  JOIN "ClassSession" s ON s."id" = c."sessionId"
  WHERE s."classId" IS NOT NULL
)
GROUP BY "studentId", "semesterId", "classId";

UPDATE "ClassSession"
SET "classId" = (
  SELECT m."newClassId"
  FROM "_ClassSemesterMap" m
  WHERE m."oldClassId" = "ClassSession"."classId"
    AND m."semesterId" = "ClassSession"."semesterId"
)
WHERE "classId" IS NOT NULL;

UPDATE "TeacherTask"
SET "classId" = (
  SELECT m."newClassId"
  FROM "FeedbackPlan" p
  JOIN "_ClassSemesterMap" m
    ON m."oldClassId" = p."classId" AND m."semesterId" = p."semesterId"
  WHERE p."id" = "TeacherTask"."planId"
);

UPDATE "FeedbackPlan"
SET "classId" = (
  SELECT m."newClassId"
  FROM "_ClassSemesterMap" m
  WHERE m."oldClassId" = "FeedbackPlan"."classId"
    AND m."semesterId" = "FeedbackPlan"."semesterId"
);

UPDATE "GenerationRecord"
SET "classId" = (
  SELECT m."newClassId"
  FROM "_ClassSemesterMap" m
  WHERE m."oldClassId" = "GenerationRecord"."classId"
    AND m."semesterId" = "GenerationRecord"."semesterId"
)
WHERE "classId" IS NOT NULL AND "semesterId" IS NOT NULL;

UPDATE "GenerationRecord"
SET "classId" = (
  SELECT m."newClassId"
  FROM "_ClassSemesterMap" m
  WHERE m."oldClassId" = "GenerationRecord"."classId"
    AND m."isPrimary" = 1
)
WHERE "classId" IS NOT NULL AND "semesterId" IS NULL;

UPDATE "MemoryCompactionRun"
SET "classId" = (
  SELECT m."newClassId"
  FROM "_ClassSemesterMap" m
  WHERE m."oldClassId" = "MemoryCompactionRun"."classId"
    AND m."semesterId" = "MemoryCompactionRun"."semesterId"
)
WHERE "semesterId" IS NOT NULL;

UPDATE "MemoryCompactionRun"
SET "classId" = (
  SELECT m."newClassId"
  FROM "_ClassSemesterMap" m
  WHERE m."oldClassId" = "MemoryCompactionRun"."classId"
    AND m."isPrimary" = 1
)
WHERE "semesterId" IS NULL;

-- Class-scoped term memories follow the deterministic class mapping. A memory
-- attached to a split historical class remains available for audit, but is
-- stale and must not be used as new-term context automatically.
UPDATE "TeachingMemory"
SET "scopeId" = (
  SELECT m."newClassId"
  FROM "_ClassSemesterMap" m
  WHERE m."oldClassId" = "TeachingMemory"."scopeId"
    AND m."semesterId" = "TeachingMemory"."semesterId"
)
WHERE "scopeType" = 'class' AND "semesterId" IS NOT NULL;

UPDATE "TeachingMemory"
SET "status" = 'stale'
WHERE "scopeType" = 'class'
  AND "semesterId" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "_ClassSemesterMap" m
    WHERE m."newClassId" = "TeachingMemory"."scopeId"
      AND m."semesterId" = "TeachingMemory"."semesterId"
      AND m."isPrimary" = 0
  );

-- Class-scoped memories from older versions did not carry a semester. Keep
-- their long-term scope attached to the class ID that remains the current /
-- latest mapping instead of leaving a reference to the pre-split ID.
UPDATE "TeachingMemory"
SET "scopeId" = (
  SELECT m."newClassId"
  FROM "_ClassSemesterMap" m
  WHERE m."oldClassId" = "TeachingMemory"."scopeId"
    AND m."isPrimary" = 1
)
WHERE "scopeType" = 'class'
  AND "semesterId" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "_ClassSemesterMap" m
    WHERE m."oldClassId" = "TeachingMemory"."scopeId"
      AND m."isPrimary" = 1
  );

CREATE TABLE "new_Class" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "semesterId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT,
  CONSTRAINT "Class_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Class" ("id", "semesterId", "code", "name")
SELECT m."newClassId", m."semesterId", c."code", c."name"
FROM "_ClassSemesterMap" m
JOIN "Class" c ON c."id" = m."oldClassId";
DROP TABLE "Class";
ALTER TABLE "new_Class" RENAME TO "Class";
CREATE UNIQUE INDEX "Class_semesterId_code_key" ON "Class"("semesterId", "code");
CREATE INDEX "Class_semesterId_name_idx" ON "Class"("semesterId", "name");

CREATE TABLE "new_ClassSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "semesterId" TEXT NOT NULL,
  "semesterNumber" INTEGER NOT NULL,
  "date" TEXT NOT NULL,
  "classId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClassSession_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ClassSession_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ClassSession" SELECT "id", "code", "semesterId", "semesterNumber", "date", "classId", "createdAt" FROM "ClassSession";
DROP TABLE "ClassSession";
ALTER TABLE "new_ClassSession" RENAME TO "ClassSession";
CREATE UNIQUE INDEX "ClassSession_code_key" ON "ClassSession"("code");

CREATE TABLE "new_FeedbackPlan" (
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
  CONSTRAINT "FeedbackPlan_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FeedbackPlan_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "FeedbackPlan_rangeStartSessionId_fkey" FOREIGN KEY ("rangeStartSessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "FeedbackPlan_rangeEndSessionId_fkey" FOREIGN KEY ("rangeEndSessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FeedbackPlan" SELECT "id", "type", "purpose", "status", "semesterId", "classId", "sessionId", "rangeStartSessionId", "rangeEndSessionId", "inputFingerprint", "planRevision", "createdAt", "updatedAt", "approvedAt", "exportedAt" FROM "FeedbackPlan";
DROP TABLE "FeedbackPlan";
ALTER TABLE "new_FeedbackPlan" RENAME TO "FeedbackPlan";
CREATE INDEX "FeedbackPlan_classId_semesterId_type_createdAt_idx" ON "FeedbackPlan"("classId", "semesterId", "type", "createdAt");
CREATE INDEX "FeedbackPlan_status_updatedAt_idx" ON "FeedbackPlan"("status", "updatedAt");

CREATE TABLE "new_Student" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "gender" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Student" ("id", "name", "studentId", "gender", "createdAt", "updatedAt")
SELECT "id", "name", "studentId", "gender", "createdAt", "updatedAt" FROM "Student";
DROP TABLE "Student";
ALTER TABLE "new_Student" RENAME TO "Student";
CREATE UNIQUE INDEX "Student_studentId_key" ON "Student"("studentId");
CREATE INDEX "Student_studentId_idx" ON "Student"("studentId");

CREATE TABLE "new_TeacherTask" (
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
  CONSTRAINT "TeacherTask_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeacherTask_dueSessionId_fkey" FOREIGN KEY ("dueSessionId") REFERENCES "ClassSession" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TeacherTask" SELECT "id", "planId", "planItemId", "studentId", "classId", "action", "promiseExcerpt", "dueType", "dueDate", "dueSessionId", "estimatedMinutes", "status", "sourceHash", "createdAt", "approvedAt", "completedAt", "updatedAt" FROM "TeacherTask";
DROP TABLE "TeacherTask";
ALTER TABLE "new_TeacherTask" RENAME TO "TeacherTask";
CREATE INDEX "TeacherTask_status_dueDate_idx" ON "TeacherTask"("status", "dueDate");
CREATE INDEX "TeacherTask_status_dueSessionId_idx" ON "TeacherTask"("status", "dueSessionId");
CREATE INDEX "TeacherTask_studentId_status_idx" ON "TeacherTask"("studentId", "status");

CREATE TABLE "StudentClassEnrollment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studentId" TEXT NOT NULL,
  "semesterId" TEXT NOT NULL,
  "classId" TEXT NOT NULL,
  "rosterStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  "statusEffectiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "StudentClassEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StudentClassEnrollment_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "StudentClassEnrollment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

WITH ranked AS (
  SELECT c."studentId", c."semesterId", c."classId", c."lastDate",
    ROW_NUMBER() OVER (
      PARTITION BY c."studentId", c."semesterId"
      ORDER BY c."lastDate" DESC, c."classId" DESC
    ) AS "rank"
  FROM "_StudentTermClassCandidates" c
  JOIN "_ClassSemesterMap" m ON m."oldClassId" = c."classId" AND m."semesterId" = c."semesterId"
)
INSERT INTO "StudentClassEnrollment" ("id", "studentId", "semesterId", "classId", "rosterStatus", "statusEffectiveAt", "createdAt", "updatedAt")
SELECT
  r."studentId" || '--' || r."semesterId",
  r."studentId",
  r."semesterId",
  m."newClassId",
  CASE WHEN r."semesterId" = (SELECT "id" FROM "_CurrentSemester") THEN legacy."rosterStatus" ELSE 'ACTIVE' END,
  CASE WHEN r."semesterId" = (SELECT "id" FROM "_CurrentSemester") THEN legacy."statusEffectiveAt" ELSE (SELECT "startDate" || 'T00:00:00.000Z' FROM "Semester" WHERE "id" = r."semesterId") END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM ranked r
JOIN "_ClassSemesterMap" m ON m."oldClassId" = r."classId" AND m."semesterId" = r."semesterId"
JOIN "_LegacyStudentRoster" legacy ON legacy."id" = r."studentId"
WHERE r."rank" = 1;

INSERT OR IGNORE INTO "StudentClassEnrollment" ("id", "studentId", "semesterId", "classId", "rosterStatus", "statusEffectiveAt", "createdAt", "updatedAt")
SELECT
  legacy."id" || '--' || current."id",
  legacy."id",
  current."id",
  m."newClassId",
  legacy."rosterStatus",
  legacy."statusEffectiveAt",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "_LegacyStudentRoster" legacy
JOIN "_CurrentSemester" current
JOIN "_ClassSemesterMap" m ON m."oldClassId" = legacy."classId" AND m."semesterId" = current."id";

CREATE UNIQUE INDEX "StudentClassEnrollment_studentId_semesterId_key" ON "StudentClassEnrollment"("studentId", "semesterId");
CREATE INDEX "StudentClassEnrollment_classId_rosterStatus_idx" ON "StudentClassEnrollment"("classId", "rosterStatus");
CREATE INDEX "StudentClassEnrollment_semesterId_rosterStatus_idx" ON "StudentClassEnrollment"("semesterId", "rosterStatus");

DROP TABLE "_StudentTermClassCandidates";
DROP TABLE "_LegacyStudentRoster";
DROP TABLE "_ClassSemesterMap";
DROP TABLE "_ClassSemesterPairs";
DROP TABLE "_CurrentSemester";

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
