-- CreateTable
CREATE TABLE "WorkHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "module" TEXT NOT NULL,
    "key" TEXT,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "WorkHistory_module_createdAt_idx" ON "WorkHistory"("module", "createdAt");

-- CreateIndex
CREATE INDEX "WorkHistory_module_key_createdAt_idx" ON "WorkHistory"("module", "key", "createdAt");
