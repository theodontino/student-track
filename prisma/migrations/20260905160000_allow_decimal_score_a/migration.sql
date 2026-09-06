-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_SessionMetric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "scoreA" REAL NOT NULL,
    "scoreB" INTEGER NOT NULL,
    "scoreC" INTEGER NOT NULL,
    "scoreD" INTEGER NOT NULL DEFAULT 3,
    "operator" TEXT NOT NULL,
    "sessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionMetric_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionMetric_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SessionMetric" ("createdAt", "date", "id", "operator", "scoreA", "scoreB", "scoreC", "scoreD", "sessionId", "studentId")
SELECT "createdAt", "date", "id", "operator", CAST("scoreA" AS REAL), "scoreB", "scoreC", "scoreD", "sessionId", "studentId" FROM "SessionMetric";
DROP TABLE "SessionMetric";
ALTER TABLE "new_SessionMetric" RENAME TO "SessionMetric";
CREATE UNIQUE INDEX "SessionMetric_studentId_sessionId_key" ON "SessionMetric"("studentId", "sessionId");

CREATE TABLE "new_SessionMetricHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "metricId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "scoreA" REAL NOT NULL,
    "scoreB" INTEGER NOT NULL,
    "scoreC" INTEGER NOT NULL,
    "scoreD" INTEGER NOT NULL,
    "operator" TEXT NOT NULL,
    "sessionId" TEXT,
    "archivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeType" TEXT NOT NULL
);
INSERT INTO "new_SessionMetricHistory" ("archivedAt", "changeType", "date", "id", "metricId", "operator", "scoreA", "scoreB", "scoreC", "scoreD", "sessionId", "studentId")
SELECT "archivedAt", "changeType", "date", "id", "metricId", "operator", CAST("scoreA" AS REAL), "scoreB", "scoreC", "scoreD", "sessionId", "studentId" FROM "SessionMetricHistory";
DROP TABLE "SessionMetricHistory";
ALTER TABLE "new_SessionMetricHistory" RENAME TO "SessionMetricHistory";
CREATE INDEX "SessionMetricHistory_studentId_idx" ON "SessionMetricHistory"("studentId");
CREATE INDEX "SessionMetricHistory_metricId_idx" ON "SessionMetricHistory"("metricId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
