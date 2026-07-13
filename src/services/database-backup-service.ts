import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const REQUIRED_TABLES = [
  "Class",
  "Student",
  "Semester",
  "ClassSession",
  "SessionMetric",
  "Attendance",
  "_prisma_migrations",
] as const;

const COUNTED_TABLES = ["Student", "Semester", "ClassSession", "SessionMetric", "Attendance"] as const;

export interface DatabaseVerification {
  integrity: "ok";
  tables: string[];
  rowCounts: Record<string, number>;
}

export interface DatabaseBackupManifest {
  formatVersion: 1;
  createdAt: string;
  databaseFile: string;
  sizeBytes: number;
  sha256: string;
  verification: DatabaseVerification;
}

export interface DatabaseBackupResult {
  backupPath: string;
  manifestPath: string;
  manifest: DatabaseBackupManifest;
}

function databaseUrlForPath(databasePath: string) {
  return `file:${databasePath}`;
}

function escapeSqlString(value: string) {
  return value.replaceAll("'", "''");
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function sha256(filePath: string) {
  return createHash("sha256").update(await readFile(/* turbopackIgnore: true */ filePath)).digest("hex");
}

export function resolveDatabasePath(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl?.startsWith("file:")) {
    throw new Error("当前备份工具仅支持本地 SQLite file: DATABASE_URL");
  }
  const value = databaseUrl.slice("file:".length);
  return isAbsolute(value) ? value : resolve(/* turbopackIgnore: true */ process.cwd(), value);
}

/**
 * Opens a SQLite database independently and verifies file integrity, required
 * schema tables, and a small set of row counts without modifying the database.
 */
export async function verifyDatabaseFile(databasePath: string): Promise<DatabaseVerification> {
  const absolutePath = resolve(/* turbopackIgnore: true */ databasePath);
  const client = createClient({ url: databaseUrlForPath(absolutePath) });
  try {
    const integrityResult = await client.execute("PRAGMA integrity_check");
    const integrityValues = integrityResult.rows.map((row) => String(row.integrity_check));
    if (integrityValues.length !== 1 || integrityValues[0] !== "ok") {
      throw new Error(`SQLite 完整性检查失败: ${integrityValues.join("; ") || "无结果"}`);
    }

    const tableResult = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
    const tables = tableResult.rows.map((row) => String(row.name)).sort();
    const missingTables = REQUIRED_TABLES.filter((table) => !tables.includes(table));
    if (missingTables.length > 0) {
      throw new Error(`备份缺少核心表: ${missingTables.join(", ")}`);
    }

    const rowCounts: Record<string, number> = {};
    for (const table of COUNTED_TABLES) {
      const result = await client.execute(`SELECT COUNT(*) AS count FROM "${table}"`);
      rowCounts[table] = Number(result.rows[0]?.count ?? 0);
    }

    return { integrity: "ok", tables, rowCounts };
  } finally {
    client.close();
  }
}

/**
 * Creates a consistent SQLite snapshot using VACUUM INTO, verifies it, and
 * writes a checksum manifest next to the database file.
 */
export async function createDatabaseBackup(options: {
  databasePath?: string;
  archiveDir?: string;
  prefix?: string;
} = {}): Promise<DatabaseBackupResult> {
  const databasePath = resolve(/* turbopackIgnore: true */ options.databasePath ?? resolveDatabasePath());
  const archiveDir = resolve(/* turbopackIgnore: true */ options.archiveDir ?? resolve(/* turbopackIgnore: true */ process.cwd(), "archives"));
  const prefix = options.prefix ?? "chem-track";
  await mkdir(/* turbopackIgnore: true */ archiveDir, { recursive: true });

  const backupPath = resolve(/* turbopackIgnore: true */ archiveDir, `${prefix}_${timestamp()}.db`);
  const manifestPath = `${backupPath}.json`;
  const client = createClient({ url: databaseUrlForPath(databasePath) });
  try {
    await client.execute(`VACUUM INTO '${escapeSqlString(backupPath)}'`);
  } finally {
    client.close();
  }

  const verification = await verifyDatabaseFile(backupPath);
  const fileStat = await stat(/* turbopackIgnore: true */ backupPath);
  const manifest: DatabaseBackupManifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    databaseFile: basename(backupPath),
    sizeBytes: fileStat.size,
    sha256: await sha256(backupPath),
    verification,
  };
  await writeFile(/* turbopackIgnore: true */ manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { backupPath, manifestPath, manifest };
}

/**
 * Verifies a backup and its checksum manifest. This is also the non-destructive
 * restore drill used in routine maintenance.
 */
export async function verifyDatabaseBackup(backupPath: string): Promise<DatabaseBackupManifest> {
  const absolutePath = resolve(/* turbopackIgnore: true */ backupPath);
  const manifestPath = `${absolutePath}.json`;
  let manifest: DatabaseBackupManifest;
  try {
    manifest = JSON.parse(await readFile(/* turbopackIgnore: true */ manifestPath, "utf8")) as DatabaseBackupManifest;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const verification = await verifyDatabaseFile(absolutePath);
    const fileStat = await stat(/* turbopackIgnore: true */ absolutePath);
    manifest = {
      formatVersion: 1,
      createdAt: fileStat.mtime.toISOString(),
      databaseFile: basename(absolutePath),
      sizeBytes: fileStat.size,
      sha256: await sha256(absolutePath),
      verification,
    };
    await writeFile(/* turbopackIgnore: true */ manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  }
  if (manifest.formatVersion !== 1 || manifest.databaseFile !== basename(absolutePath)) {
    throw new Error("备份清单格式或文件名不匹配");
  }
  const checksum = await sha256(absolutePath);
  if (checksum !== manifest.sha256) throw new Error("备份校验和不匹配，文件可能已损坏");

  const verification = await verifyDatabaseFile(absolutePath);
  return { ...manifest, verification };
}

/**
 * Restores a verified backup from the configured archives directory. The live
 * application must be stopped first. A pre-restore backup is created, and is
 * used to roll back automatically if post-restore verification fails.
 */
export async function restoreDatabaseBackup(options: {
  backupPath: string;
  databasePath?: string;
  archiveDir?: string;
}) {
  const databasePath = resolve(/* turbopackIgnore: true */ options.databasePath ?? resolveDatabasePath());
  const archiveDir = resolve(/* turbopackIgnore: true */ options.archiveDir ?? resolve(/* turbopackIgnore: true */ process.cwd(), "archives"));
  const backupPath = resolve(/* turbopackIgnore: true */ options.backupPath);
  const relativeBackupPath = relative(archiveDir, backupPath);
  if (relativeBackupPath.startsWith("..") || isAbsolute(relativeBackupPath)) {
    throw new Error("只能恢复 archives 目录中的备份");
  }

  const restoredManifest = await verifyDatabaseBackup(backupPath);
  const preRestore = await createDatabaseBackup({
    databasePath,
    archiveDir,
    prefix: "pre-restore",
  });
  const temporaryPath = resolve(/* turbopackIgnore: true */ dirname(databasePath), `.${basename(databasePath)}.restore-${Date.now()}`);

  try {
    await copyFile(/* turbopackIgnore: true */ backupPath, temporaryPath);
    await rename(/* turbopackIgnore: true */ temporaryPath, databasePath);
    await rm(/* turbopackIgnore: true */ `${databasePath}-wal`, { force: true });
    await rm(/* turbopackIgnore: true */ `${databasePath}-shm`, { force: true });
    const verification = await verifyDatabaseFile(databasePath);
    return { restoredManifest, preRestore, verification };
  } catch (error) {
    await rm(/* turbopackIgnore: true */ temporaryPath, { force: true });
    await copyFile(/* turbopackIgnore: true */ preRestore.backupPath, databasePath);
    await verifyDatabaseFile(databasePath);
    throw error;
  }
}
