PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Student" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "rosterStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "statusEffectiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Student_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_Student" (
    "id",
    "name",
    "classId",
    "studentId",
    "gender",
    "rosterStatus",
    "statusEffectiveAt",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "name",
    "classId",
    "studentId",
    "gender",
    'ACTIVE',
    CURRENT_TIMESTAMP,
    "createdAt",
    "updatedAt"
FROM "Student";

DROP TABLE "Student";
ALTER TABLE "new_Student" RENAME TO "Student";

CREATE UNIQUE INDEX "Student_studentId_key" ON "Student"("studentId");
CREATE INDEX "Student_rosterStatus_classId_idx" ON "Student"("rosterStatus", "classId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
