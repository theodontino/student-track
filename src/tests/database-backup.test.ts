import { createClient } from "@libsql/client";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sqliteFileUrl } from "@/lib/sqlite-file-url";
import {
  createDatabaseBackup,
  resolveDatabasePath,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
  verifyDatabaseFile,
} from "@/services/database-backup-service";

let testRoot = "";

async function createTestDatabase(databasePath: string) {
  const client = createClient({ url: sqliteFileUrl(databasePath) });
  for (const table of [
    "Class",
    "Student",
    "Semester",
    "ClassSession",
    "SessionMetric",
    "Attendance",
    "_prisma_migrations",
  ]) {
    await client.execute(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY)`);
  }
  await client.execute("INSERT INTO Student (id) VALUES ('student-1')");
  client.close();
}

afterEach(async () => {
  // The Windows native SQLite handle is released when the Vitest child exits;
  // its isolated parent directory is then removed by run-isolated-tests.
  if (testRoot && process.platform !== "win32") {
    await rm(testRoot, { recursive: true, force: true });
  }
  testRoot = "";
});

function testParentDirectory() {
  return process.env.STUDENT_TRACK_RUNTIME_ROOT || tmpdir();
}

describe("database backup and restore", () => {
  it("resolves absolute SQLite file connection strings with spaces", () => {
    const databasePath = resolve(tmpdir(), "Student Track", "database", "student-track.db");
    const databaseUrl = sqliteFileUrl(databasePath);

    expect(databaseUrl).toBe(`file:${databasePath.replaceAll("\\", "/")}`);
    expect(databaseUrl).toContain("Student Track");
    expect(databaseUrl).not.toContain("%20");
    expect(resolveDatabasePath(databaseUrl)).toBe(databasePath);
  });

  it("creates, verifies, and restores a consistent snapshot", async () => {
    testRoot = await mkdtemp(resolve(testParentDirectory(), "database-backup-"));
    const databasePath = resolve(testRoot, "live.db");
    const archiveDir = resolve(testRoot, "archives");
    await createTestDatabase(databasePath);

    const backup = await createDatabaseBackup({ databasePath, archiveDir, prefix: "test" });
    await expect(verifyDatabaseBackup(backup.backupPath)).resolves.toMatchObject({
      verification: { integrity: "ok", rowCounts: { Student: 1 } },
    });

    const client = createClient({ url: sqliteFileUrl(databasePath) });
    await client.execute("INSERT INTO Student (id) VALUES ('student-2')");
    client.close();

    const restored = await restoreDatabaseBackup({ backupPath: backup.backupPath, databasePath, archiveDir });
    expect(restored.verification.rowCounts.Student).toBe(1);
    await expect(verifyDatabaseFile(databasePath)).resolves.toMatchObject({ rowCounts: { Student: 1 } });
  });

  it("rejects a backup whose checksum no longer matches", async () => {
    testRoot = await mkdtemp(resolve(testParentDirectory(), "database-backup-"));
    const databasePath = resolve(testRoot, "live.db");
    const archiveDir = resolve(testRoot, "archives");
    await createTestDatabase(databasePath);
    const backup = await createDatabaseBackup({ databasePath, archiveDir, prefix: "test" });

    await appendFile(backup.backupPath, "tampered");
    await expect(verifyDatabaseBackup(backup.backupPath)).rejects.toThrow("校验和不匹配");
  });
});
