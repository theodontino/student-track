import { createClient } from "@libsql/client";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDatabaseBackup,
  resolveDatabasePath,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
  verifyDatabaseFile,
} from "@/services/database-backup-service";

let testRoot = "";

async function createTestDatabase(databasePath: string) {
  const client = createClient({ url: pathToFileURL(databasePath).href });
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
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
  testRoot = "";
});

describe("database backup and restore", () => {
  it("resolves standards-compliant SQLite file URLs", () => {
    const databasePath = resolve(tmpdir(), "Student Track", "database", "student-track.db");
    expect(resolveDatabasePath(pathToFileURL(databasePath).href)).toBe(databasePath);
  });

  it("creates, verifies, and restores a consistent snapshot", async () => {
    testRoot = await mkdtemp(resolve(tmpdir(), "student-track-backup-"));
    const databasePath = resolve(testRoot, "live.db");
    const archiveDir = resolve(testRoot, "archives");
    await createTestDatabase(databasePath);

    const backup = await createDatabaseBackup({ databasePath, archiveDir, prefix: "test" });
    await expect(verifyDatabaseBackup(backup.backupPath)).resolves.toMatchObject({
      verification: { integrity: "ok", rowCounts: { Student: 1 } },
    });

    const client = createClient({ url: pathToFileURL(databasePath).href });
    await client.execute("INSERT INTO Student (id) VALUES ('student-2')");
    client.close();

    const restored = await restoreDatabaseBackup({ backupPath: backup.backupPath, databasePath, archiveDir });
    expect(restored.verification.rowCounts.Student).toBe(1);
    await expect(verifyDatabaseFile(databasePath)).resolves.toMatchObject({ rowCounts: { Student: 1 } });
  });

  it("rejects a backup whose checksum no longer matches", async () => {
    testRoot = await mkdtemp(resolve(tmpdir(), "student-track-backup-"));
    const databasePath = resolve(testRoot, "live.db");
    const archiveDir = resolve(testRoot, "archives");
    await createTestDatabase(databasePath);
    const backup = await createDatabaseBackup({ databasePath, archiveDir, prefix: "test" });

    await appendFile(backup.backupPath, "tampered");
    await expect(verifyDatabaseBackup(backup.backupPath)).rejects.toThrow("校验和不匹配");
  });
});
