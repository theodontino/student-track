import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertDatabaseFingerprintUnchanged,
  fingerprintDatabaseFiles,
} from "../../scripts/database-fingerprint";

describe("real database verification fingerprint", () => {
  let directory = "";
  let databasePath = "";

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "student-track-fingerprint-"));
    databasePath = path.join(directory, "dev.db");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("treats an absent database and WAL as a stable state", async () => {
    const before = await fingerprintDatabaseFiles(databasePath);
    const after = await fingerprintDatabaseFiles(databasePath);
    expect(() => assertDatabaseFingerprintUnchanged(before, after)).not.toThrow();
  });

  it("accepts unchanged size, mtime and SHA-256", async () => {
    fs.writeFileSync(databasePath, "synthetic-database");
    const before = await fingerprintDatabaseFiles(databasePath);
    const after = await fingerprintDatabaseFiles(databasePath);
    expect(() => assertDatabaseFingerprintUnchanged(before, after)).not.toThrow();
  });

  it("rejects changes to the database or WAL", async () => {
    fs.writeFileSync(databasePath, "synthetic-database");
    fs.writeFileSync(`${databasePath}-wal`, "synthetic-wal");
    const before = await fingerprintDatabaseFiles(databasePath);

    fs.appendFileSync(`${databasePath}-wal`, "-changed");
    const afterWalChange = await fingerprintDatabaseFiles(databasePath);
    expect(() => assertDatabaseFingerprintUnchanged(before, afterWalChange)).toThrow("WAL");

    fs.writeFileSync(`${databasePath}-wal`, "synthetic-wal");
    fs.appendFileSync(databasePath, "-changed");
    const afterDatabaseChange = await fingerprintDatabaseFiles(databasePath);
    expect(() => assertDatabaseFingerprintUnchanged(before, afterDatabaseChange)).toThrow("主文件");
  });
});
