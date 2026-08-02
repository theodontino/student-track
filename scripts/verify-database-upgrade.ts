import "dotenv/config";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { access, copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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

type PreservedColumns = Record<(typeof BUSINESS_TABLES)[number], string[]>;
type DatabaseInspection = Awaited<ReturnType<typeof inspect>>;

const FIRST_V1_1_MIGRATION = "20260729140000_add_student_roster_status";
const V1_1_MIGRATION_COUNT = 7;
const V1_1_TABLES = [
  "FeedbackGenerationSelection",
  "CommunicationRevision",
  "FeedbackPlan",
  "FeedbackPlanItem",
  "TeacherTask",
  "CommunicationPreference",
  "CommunicationPreferenceCandidate",
  "FeedbackAttachment",
  "FeedbackExportRun",
] as const;

function quoteIdentifier(value: string) {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function stableValue(value: unknown) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

async function inspect(databasePath: string, preservedColumns?: PreservedColumns) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const integrity = await client.execute("PRAGMA integrity_check");
    const rowCounts: Record<string, number> = {};
    const columns = {} as PreservedColumns;
    const contentFingerprints: Record<string, string> = {};
    for (const table of BUSINESS_TABLES) {
      const result = await client.execute(`SELECT COUNT(*) AS count FROM "${table}"`);
      rowCounts[table] = Number(result.rows[0]?.count ?? 0);
      const selectedColumns = preservedColumns?.[table] ?? (
        await client.execute(`PRAGMA table_info(${quoteIdentifier(table)})`)
      ).rows.map((row) => String(row.name));
      columns[table] = selectedColumns;
      const rows = await client.execute(
        `SELECT ${selectedColumns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`,
      );
      const canonicalRows = rows.rows.map((row) => JSON.stringify(
        Object.fromEntries(selectedColumns.map((column) => [column, stableValue(row[column])])),
      )).sort();
      contentFingerprints[table] = createHash("sha256")
        .update(canonicalRows.join("\n"))
        .digest("hex");
    }
    return {
      integrity: integrity.rows.map((row) => String(row.integrity_check)),
      rowCounts,
      columns,
      contentFingerprints,
    };
  } finally {
    client.close();
  }
}

function assertPreserved(before: DatabaseInspection, after: DatabaseInspection, label: string) {
  if (before.integrity.join(",") !== "ok" || after.integrity.join(",") !== "ok") {
    throw new Error(`${label}完整性检查失败`);
  }
  if (JSON.stringify(before.rowCounts) !== JSON.stringify(after.rowCounts)) {
    throw new Error(`${label}迁移改变了既有业务表行数`);
  }
  if (JSON.stringify(before.contentFingerprints) !== JSON.stringify(after.contentFingerprints)) {
    throw new Error(`${label}迁移改变了既有业务表原字段内容`);
  }
}

async function assertV11Schema(databasePath: string, options: { expectAllStudentsActive: boolean }) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const expectedTables = [
      "WeComImportState", "WeComImportRun", "WeComImportOperation", "WeComMessageReceipt", "WeComImportChange",
      "TeachingSummaryCache", "TeacherObservation", "TeacherObservationSource",
      "GenerationRecord", "TeachingMemory", "MemoryCompactionRun",
      ...V1_1_TABLES,
    ];
    const result = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${expectedTables.map(() => "?").join(",")})`,
      args: expectedTables,
    });
    if (Number(result.rows[0]?.count ?? 0) !== expectedTables.length) {
      throw new Error("集成账本、教学总结或 1.1 账本表不完整");
    }
    const invalidRoster = await client.execute(
      "SELECT COUNT(*) AS count FROM Student WHERE rosterStatus NOT IN ('ACTIVE', 'INACTIVE') OR statusEffectiveAt IS NULL",
    );
    if (Number(invalidRoster.rows[0]?.count ?? 0) !== 0) {
      throw new Error("学生状态存在空值或非法值");
    }
    if (options.expectAllStudentsActive) {
      const inactiveRoster = await client.execute(
        "SELECT COUNT(*) AS count FROM Student WHERE rosterStatus <> 'ACTIVE'",
      );
      if (Number(inactiveRoster.rows[0]?.count ?? 0) !== 0) {
        throw new Error("固定合成旧库的既有学生没有被无损归一化为 active");
      }
    }
  } finally {
    client.close();
  }
}

async function migrationNames(projectRoot: string) {
  const directory = path.join(projectRoot, "prisma", "migrations");
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function applyMigrationFiles(projectRoot: string, databasePath: string, names: string[]) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    for (const name of names) {
      const sql = await readFile(
        path.join(projectRoot, "prisma", "migrations", name, "migration.sql"),
        "utf8",
      );
      await client.executeMultiple(sql);
    }
  } finally {
    client.close();
  }
}

async function verifySyntheticUpgrade(projectRoot: string, temporaryDirectory: string) {
  const databasePath = path.join(temporaryDirectory, "synthetic-old.db");
  const names = await migrationNames(projectRoot);
  const oldNames = names.filter((name) => name < FIRST_V1_1_MIGRATION);
  const v11Names = names.filter((name) => name >= FIRST_V1_1_MIGRATION);
  if (v11Names[0] !== FIRST_V1_1_MIGRATION || v11Names.length !== V1_1_MIGRATION_COUNT) {
    throw new Error("1.1 迁移集合与固定合成旧库门禁不一致");
  }
  await applyMigrationFiles(projectRoot, databasePath, oldNames);
  const client = createClient({ url: `file:${databasePath}` });
  try {
    await client.executeMultiple(`
      INSERT INTO "Class" ("id", "code", "name") VALUES ('class-fixed', 'FIXED-1', '固定合成班');
      INSERT INTO "Student" ("id", "name", "classId", "studentId", "gender", "createdAt", "updatedAt")
        VALUES ('student-fixed', '固定学生', 'class-fixed', 'FIXED-STUDENT-1', '女', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z');
      INSERT INTO "Semester" ("id", "name", "startDate", "endDate", "createdAt")
        VALUES ('semester-fixed', '固定合成学期', '2026-01-01', '2026-06-30', '2026-01-01T00:00:00.000Z');
      INSERT INTO "ClassSession" ("id", "code", "semesterId", "semesterNumber", "date", "classId", "createdAt")
        VALUES ('session-fixed', '2026010201', 'semester-fixed', 1, '2026-01-02', 'class-fixed', '2026-01-02T00:00:00.000Z');
      INSERT INTO "SessionMetric" ("id", "studentId", "date", "scoreA", "scoreB", "scoreC", "scoreD", "operator", "sessionId", "createdAt")
        VALUES ('metric-fixed', 'student-fixed', '2026-01-02', 4, 3, 5, 4, 'teacher', 'session-fixed', '2026-01-02T04:00:00.000Z');
      INSERT INTO "Attendance" ("id", "sessionId", "studentId", "present", "createdAt")
        VALUES ('attendance-fixed', 'session-fixed', 'student-fixed', 1, '2026-01-02T04:00:00.000Z');
      INSERT INTO "Event" ("id", "studentId", "sessionId", "type", "description", "rawText", "createdAt")
        VALUES ('event-fixed', 'student-fixed', 'session-fixed', '课堂表现', '固定表现', '固定原始事实', '2026-01-02T04:00:00.000Z');
      INSERT INTO "Communication" ("id", "studentId", "sessionId", "target", "summary", "sourceKey", "createdAt")
        VALUES ('communication-fixed', 'student-fixed', 'session-fixed', '母亲', '固定沟通摘要', 'fixed-source-key', '2026-01-02T04:00:00.000Z');
      INSERT INTO "WorkHistory" ("id", "module", "key", "title", "state", "createdAt")
        VALUES ('history-fixed', 'feedback', '2026010201', '固定旧反馈历史', '{"students":[{"id":"student-fixed","feedback":"固定历史内容"}]}', '2026-01-02T05:00:00.000Z');
    `);
  } finally {
    client.close();
  }
  const before = await inspect(databasePath);
  await applyMigrationFiles(projectRoot, databasePath, v11Names);
  const after = await inspect(databasePath, before.columns);
  assertPreserved(before, after, "固定合成旧库");
  await assertV11Schema(databasePath, { expectAllStudentsActive: true });
}

async function main() {
  const projectRoot = process.cwd();
  const liveDatabase = resolveDatabasePath();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "student-track-upgrade-"));
  const copiedDatabase = path.join(temporaryDirectory, "upgrade.db");
  try {
    const verifiedLiveCopy = await access(liveDatabase).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (verifiedLiveCopy) {
      await copyFile(liveDatabase, copiedDatabase);
      const before = await inspect(copiedDatabase);
      const prismaCli = path.join(projectRoot, "node_modules", "prisma", "build", "index.js");
      const migration = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: `file:${copiedDatabase}` },
        stdio: "pipe",
        encoding: "utf8",
      });
      if (migration.status !== 0) {
        const details = [migration.stdout, migration.stderr]
          .map((value) => value.trim())
          .filter(Boolean)
          .join("\n");
        throw new Error(`数据库副本迁移失败${details ? `：\n${details}` : ""}`);
      }
      const after = await inspect(copiedDatabase, before.columns);
      assertPreserved(before, after, "真实数据库副本");
      await assertV11Schema(copiedDatabase, { expectAllStudentsActive: false });
    }
    await verifySyntheticUpgrade(projectRoot, temporaryDirectory);
    console.log(
      verifiedLiveCopy
        ? "数据库升级验证通过：全新迁移链、固定合成旧库和真实库副本均正常；既有业务表行数与原字段内容指纹未改变，1.1 账本表完整。"
        : "数据库升级验证通过：全新迁移链和固定合成旧库均正常；未发现可读取的真实数据库，已跳过真实库副本验证。",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "数据库副本升级验证失败");
  process.exitCode = 1;
});
