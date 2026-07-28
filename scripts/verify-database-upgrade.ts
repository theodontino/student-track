import "dotenv/config";
import { createClient } from "@libsql/client";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDatabasePath } from "../src/services/database-backup-service";

const BUSINESS_TABLES = [
  "Class",
  "Student",
  "Semester",
  "ClassSession",
  "SessionMetric",
  "Attendance",
  "Event",
  "Communication",
  "Label",
  "StudentLabel",
  "DraftRecord",
  "WorkHistory",
  "SystemLog",
  "SessionMetricHistory",
] as const;

async function inspect(databasePath: string) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const integrity = await client.execute("PRAGMA integrity_check");
    const rowCounts: Record<string, number> = {};
    for (const table of BUSINESS_TABLES) {
      const result = await client.execute(`SELECT COUNT(*) AS count FROM "${table}"`);
      rowCounts[table] = Number(result.rows[0]?.count ?? 0);
    }
    return {
      integrity: integrity.rows.map((row) => String(row.integrity_check)),
      rowCounts,
    };
  } finally {
    client.close();
  }
}

async function main() {
  const projectRoot = process.cwd();
  const liveDatabase = resolveDatabasePath();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "student-track-upgrade-"));
  const copiedDatabase = path.join(temporaryDirectory, "upgrade.db");
  try {
    await copyFile(liveDatabase, copiedDatabase);
    const before = await inspect(copiedDatabase);
    const prismaCli = path.join(projectRoot, "node_modules", "prisma", "build", "index.js");
    const migration = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: `file:${copiedDatabase}` },
      stdio: "pipe",
      encoding: "utf8",
    });
    if (migration.status !== 0) throw new Error("数据库副本迁移失败");
    const after = await inspect(copiedDatabase);
    if (before.integrity.join(",") !== "ok" || after.integrity.join(",") !== "ok") {
      throw new Error("数据库副本完整性检查失败");
    }
    if (JSON.stringify(before.rowCounts) !== JSON.stringify(after.rowCounts)) {
      throw new Error("迁移改变了既有业务表行数");
    }
    const client = createClient({ url: `file:${copiedDatabase}` });
    try {
      const expectedTables = [
        "WeComImportState", "WeComImportRun", "WeComImportOperation", "WeComMessageReceipt", "WeComImportChange",
        "TeachingSummaryCache", "TeacherObservation", "TeacherObservationSource",
        "GenerationRecord", "TeachingMemory", "MemoryCompactionRun",
      ];
      const result = await client.execute({
        sql: `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${expectedTables.map(() => "?").join(",")})`,
        args: expectedTables,
      });
      if (Number(result.rows[0]?.count ?? 0) !== expectedTables.length) {
        throw new Error("集成账本或教学总结表不完整");
      }
    } finally {
      client.close();
    }
    console.log("数据库副本升级验证通过：完整性正常，既有业务表行数未改变，集成账本与教学总结表完整。");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "数据库副本升级验证失败");
  process.exitCode = 1;
});
