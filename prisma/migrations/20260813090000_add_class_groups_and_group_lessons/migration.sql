CREATE TABLE "ClassGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "semesterId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClassGroup_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ClassGroupMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ClassGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClassGroupMembership_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "GroupLesson" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "materialSnapshot" TEXT NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GroupLesson_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ClassGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "GroupLessonRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupLessonId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "materialSnapshot" TEXT NOT NULL,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupLessonRevision_groupLessonId_fkey" FOREIGN KEY ("groupLessonId") REFERENCES "GroupLesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "GroupLessonSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupLessonId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "syncStatus" TEXT NOT NULL,
    "differenceSummary" TEXT,
    "comparable" BOOLEAN NOT NULL DEFAULT true,
    "confirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GroupLessonSession_groupLessonId_fkey" FOREIGN KEY ("groupLessonId") REFERENCES "GroupLesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupLessonSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClassSession" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ClassGroup_semesterId_name_key" ON "ClassGroup"("semesterId", "name");
CREATE INDEX "ClassGroup_semesterId_updatedAt_idx" ON "ClassGroup"("semesterId", "updatedAt");
CREATE UNIQUE INDEX "ClassGroupMembership_classId_key" ON "ClassGroupMembership"("classId");
CREATE UNIQUE INDEX "ClassGroupMembership_groupId_classId_key" ON "ClassGroupMembership"("groupId", "classId");
CREATE INDEX "ClassGroupMembership_groupId_idx" ON "ClassGroupMembership"("groupId");
CREATE UNIQUE INDEX "GroupLesson_groupId_sequence_key" ON "GroupLesson"("groupId", "sequence");
CREATE INDEX "GroupLesson_groupId_updatedAt_idx" ON "GroupLesson"("groupId", "updatedAt");
CREATE UNIQUE INDEX "GroupLessonRevision_groupLessonId_revision_key" ON "GroupLessonRevision"("groupLessonId", "revision");
CREATE INDEX "GroupLessonRevision_groupLessonId_confirmedAt_idx" ON "GroupLessonRevision"("groupLessonId", "confirmedAt");
CREATE UNIQUE INDEX "GroupLessonSession_sessionId_key" ON "GroupLessonSession"("sessionId");
CREATE UNIQUE INDEX "GroupLessonSession_groupLessonId_sessionId_key" ON "GroupLessonSession"("groupLessonId", "sessionId");
CREATE INDEX "GroupLessonSession_groupLessonId_syncStatus_idx" ON "GroupLessonSession"("groupLessonId", "syncStatus");
