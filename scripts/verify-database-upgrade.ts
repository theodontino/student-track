import "dotenv/config";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { access, copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveDatabasePath } from "../src/services/database-backup-service";

// These tables contain business evidence or audit text. Foreign-key columns
// that are intentionally remapped by the semester migration are omitted from
// their fingerprints; identities, counts and evidence content must remain.
const PRESERVED_COLUMNS: Record<string, string[]> = {
  Semester: ["id", "name", "startDate", "endDate", "createdAt", "feedbackScriptLibraryName", "feedbackScriptLibraryJson", "feedbackScriptLibraryUpdatedAt"],
  Student: ["id", "studentId", "name", "gender", "createdAt", "updatedAt"],
  Label: ["id", "name"],
  StudentLabel: ["studentId", "labelId"],
  ClassSession: ["id", "code", "semesterId", "semesterNumber", "date", "createdAt"],
  SessionMetric: ["id", "studentId", "date", "scoreA", "scoreB", "scoreC", "scoreD", "operator", "createdAt"],
  SessionMetricHistory: ["id", "metricId", "studentId", "date", "scoreA", "scoreB", "scoreC", "scoreD", "operator", "archivedAt", "changeType"],
  Attendance: ["id", "studentId", "present", "createdAt"],
  Event: ["id", "studentId", "type", "description", "rawText", "createdAt"],
  Communication: ["id", "studentId", "target", "summary", "sourceKey", "createdAt"],
  DraftRecord: ["id", "rawText", "parsedResult", "reviewResult", "status", "sessionCode", "studentId", "createdAt"],
  SystemLog: ["id", "action", "targetType", "targetId", "targetName", "detail", "createdAt"],
  // `purpose` is renamed to `outputRequirement` by a later migration; use
  // common columns here and assert the renamed value separately.
  FeedbackPlan: ["id", "type", "status", "semesterId", "sessionId", "rangeStartSessionId", "rangeEndSessionId", "inputFingerprint", "planRevision", "createdAt", "updatedAt", "approvedAt", "exportedAt"],
  FeedbackPlanItem: ["id", "planId", "studentId", "status", "evidenceSnapshot", "compositionSnapshot", "auditSnapshot", "finalText", "finalTextHash", "selectedGenerationId", "reviewMode", "itemRevision", "createdAt", "updatedAt", "approvedAt", "exportedAt"],
  TeacherTask: ["id", "planId", "planItemId", "studentId", "action", "promiseExcerpt", "dueType", "dueDate", "estimatedMinutes", "status", "sourceHash", "createdAt", "approvedAt", "completedAt", "updatedAt"],
  GenerationRecord: ["id", "taskType", "stage", "lifecycle", "studentId", "operationKey", "sourceRefs", "sourceFingerprint", "promptVersion", "modelName", "modelRole", "modelProfileId", "modelSettings", "inputRevision", "parentGenerationId", "feedbackPlanItemId", "variantKey", "inputSnapshot", "outputSnapshot", "finalText", "warmSnapshot", "generatedAt", "adoptedAt", "compactedAt", "purgedAt", "staleAt", "createdAt", "updatedAt"],
  TeachingMemory: ["id", "scopeType", "semesterKey", "memoryTier", "content", "sourceRefs", "sourceFingerprint", "effectiveThrough", "generatedAt", "confirmedAt", "createdAt", "updatedAt"],
  MemoryCompactionRun: ["id", "semesterId", "fromSessionId", "toSessionId", "phase", "status", "sourceFingerprint", "affectedCount", "resultJson", "rollbackPayload", "undoUntil", "failureCode", "createdAt", "completedAt", "updatedAt"],
};

const FEEDBACK_PLAN_129_COLUMNS = [
  "id",
  "type",
  "outputRequirement",
  "status",
  "semesterId",
  "classId",
  "sessionId",
  "rangeStartSessionId",
  "rangeEndSessionId",
  "inputFingerprint",
  "inputSnapshot",
  "generationMode",
  "generationStartedAt",
  "generationCompletedAt",
  "generationElapsedMs",
  "generationRunStartedAt",
  "planRevision",
  "createdAt",
  "updatedAt",
  "approvedAt",
  "exportedAt",
  "archivedAt",
  "batchId",
  "batchOrder",
];

const FEEDBACK_PLAN_BATCH_129_COLUMNS = [
  "id",
  "requestKey",
  "semesterId",
  "type",
  "outputRequirement",
  "generationMode",
  "status",
  "currentPlanId",
  "failedPlanId",
  "sharedLessonRevisionId",
  "planRevision",
  "createdAt",
  "updatedAt",
  "archivedAt",
];

const FEEDBACK_129_PRESERVED_COLUMNS: Record<string, string[]> = {
  FeedbackPlan: FEEDBACK_PLAN_129_COLUMNS,
  FeedbackPlanBatch: FEEDBACK_PLAN_BATCH_129_COLUMNS,
};

const FEEDBACK_1210_PRESERVED_COLUMNS: Record<string, string[]> = {
  FeedbackPlan: [...FEEDBACK_PLAN_129_COLUMNS, "displayName", "basedOnPlanId"],
  FeedbackPlanBatch: [...FEEDBACK_PLAN_BATCH_129_COLUMNS, "displayName", "basedOnBatchId"],
};

type Inspection = {
  integrity: string[];
  foreignKeys: string[];
  rowCounts: Record<string, number>;
  contentFingerprints: Record<string, string>;
  columns: Record<string, string[]>;
};

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function stableValue(value: unknown) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
}

async function existingTables(client: ReturnType<typeof createClient>) {
  const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  return new Set(result.rows.map((row) => String(row.name)));
}

async function tableRowCount(client: ReturnType<typeof createClient>, table: string) {
  const result = await client.execute(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function inspect(
  databasePath: string,
  preservedColumns: Record<string, string[]> = PRESERVED_COLUMNS,
): Promise<Inspection> {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const tables = await existingTables(client);
    const rowCounts: Record<string, number> = {};
    const contentFingerprints: Record<string, string> = {};
    const columns: Record<string, string[]> = {};
    for (const [table, requestedColumns] of Object.entries(preservedColumns)) {
      if (!tables.has(table)) continue;
      const info = await client.execute(`PRAGMA table_info(${quoteIdentifier(table)})`);
      const available = new Set(info.rows.map((row) => String(row.name)));
      const selected = requestedColumns.filter((column) => available.has(column));
      if (selected.length === 0) continue;
      columns[table] = selected;
      const count = await client.execute(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
      rowCounts[table] = Number(count.rows[0]?.count ?? 0);
      const rows = await client.execute(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`);
      const canonicalRows = rows.rows.map((row) => JSON.stringify(
        Object.fromEntries(selected.map((column) => [column, stableValue(row[column])])),
      )).sort();
      contentFingerprints[table] = createHash("sha256").update(canonicalRows.join("\n")).digest("hex");
    }
    const integrity = await client.execute("PRAGMA integrity_check");
    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    return {
      integrity: integrity.rows.map((row) => String(row.integrity_check)),
      foreignKeys: foreignKeys.rows.map((row) => JSON.stringify(row)),
      rowCounts,
      contentFingerprints,
      columns,
    };
  } finally {
    client.close();
  }
}

function assertPreserved(before: Inspection, after: Inspection, label: string) {
  if (before.integrity.join(",") !== "ok" || after.integrity.join(",") !== "ok") throw new Error(`${label} integrity_check 失败`);
  if (before.foreignKeys.length || after.foreignKeys.length) throw new Error(`${label} foreign_key_check 失败`);
  for (const table of Object.keys(before.rowCounts)) {
    if (before.rowCounts[table] !== after.rowCounts[table]) throw new Error(`${label} ${table} 行数变化：${before.rowCounts[table]} -> ${after.rowCounts[table]}`);
    if (before.contentFingerprints[table] !== after.contentFingerprints[table]) throw new Error(`${label} ${table} 证据内容指纹变化`);
  }
}

function assertColumnsAvailable(
  inspection: Inspection,
  expectedColumns: Record<string, string[]>,
  label: string,
) {
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const available = new Set(inspection.columns[table] ?? []);
    const missing = expected.filter((column) => !available.has(column));
    if (missing.length) throw new Error(`${label} ${table} 缺少待比较旧列：${missing.join(", ")}`);
  }
}

async function assertNewSchema(databasePath: string) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const tables = await existingTables(client);
    for (const table of ["StudentClassEnrollment", "Class", "Student", "FeedbackPlan", "FeedbackPlanBatch"]) {
      if (!tables.has(table)) throw new Error(`缺少新表 ${table}`);
    }
    const studentColumns = new Set((await client.execute("PRAGMA table_info(\"Student\")")).rows.map((row) => String(row.name)));
    const semesterColumns = new Set((await client.execute("PRAGMA table_info(\"Semester\")")).rows.map((row) => String(row.name)));
    const classColumns = new Set((await client.execute("PRAGMA table_info(\"Class\")")).rows.map((row) => String(row.name)));
    const draftColumns = new Set((await client.execute("PRAGMA table_info(\"DraftRecord\")")).rows.map((row) => String(row.name)));
    const classGroupColumns = new Set((await client.execute("PRAGMA table_info(\"ClassGroup\")")).rows.map((row) => String(row.name)));
    if (studentColumns.has("classId") || studentColumns.has("rosterStatus") || studentColumns.has("statusEffectiveAt")) throw new Error("Student 仍包含全局班级或花名册字段");
    if (!classColumns.has("semesterId") || !classColumns.has("deletedAt")) throw new Error("Class 缺少 semesterId 或回收站字段");
    if (!semesterColumns.has("deletedAt")) throw new Error("Semester 缺少回收站字段");
    if (!draftColumns.has("intakeRunId")) throw new Error("DraftRecord 缺少录入运行关联字段");
    if (!classGroupColumns.has("leadClassId")) throw new Error("ClassGroup 缺少主班字段");
    const planInfo = await client.execute("PRAGMA table_info(\"FeedbackPlan\")");
    const batchInfo = await client.execute("PRAGMA table_info(\"FeedbackPlanBatch\")");
    const planColumns = new Set(planInfo.rows.map((row) => String(row.name)));
    const batchColumns = new Set(batchInfo.rows.map((row) => String(row.name)));
    const planItemColumns = new Set((await client.execute("PRAGMA table_info(\"FeedbackPlanItem\")")).rows.map((row) => String(row.name)));
    if (!["displayName", "basedOnPlanId", "outputRequirement", "inputSnapshot", "archivedAt", "generationMode", "generationStartedAt", "generationCompletedAt", "generationElapsedMs", "generationRunStartedAt"].every((column) => planColumns.has(column))) {
      throw new Error("FeedbackPlan 缺少命名、来源、快照、归档、生成模式或计时字段");
    }
    if (!["displayName", "basedOnBatchId"].every((column) => batchColumns.has(column))) {
      throw new Error("FeedbackPlanBatch 缺少命名或来源字段");
    }
    if (!["generationError", "generationStartedAt", "generationCompletedAt", "generationDurationMs"].every((column) => planItemColumns.has(column))) {
      throw new Error("FeedbackPlanItem 缺少生成失败或计时字段");
    }
    const batchStatus = batchInfo.rows.find((row) => String(row.name) === "status");
    const batchStatusDefault = String(batchStatus?.dflt_value ?? "").replaceAll("'", "").replaceAll('"', "");
    if (batchStatusDefault !== "draft") throw new Error(`FeedbackPlanBatch status 默认值不是 draft：${String(batchStatus?.dflt_value ?? "NULL")}`);
    const planForeignKeys = await client.execute("PRAGMA foreign_key_list(\"FeedbackPlan\")");
    const batchForeignKeys = await client.execute("PRAGMA foreign_key_list(\"FeedbackPlanBatch\")");
    const hasPlanSelfReference = planForeignKeys.rows.some((row) => (
      String(row.table) === "FeedbackPlan"
      && String(row.from) === "basedOnPlanId"
      && String(row.to) === "id"
      && String(row.on_delete).toUpperCase() === "SET NULL"
    ));
    const hasBatchSelfReference = batchForeignKeys.rows.some((row) => (
      String(row.table) === "FeedbackPlanBatch"
      && String(row.from) === "basedOnBatchId"
      && String(row.to) === "id"
      && String(row.on_delete).toUpperCase() === "SET NULL"
    ));
    if (!hasPlanSelfReference) throw new Error("FeedbackPlan 缺少 basedOnPlanId 自关联外键");
    if (!hasBatchSelfReference) throw new Error("FeedbackPlanBatch 缺少 basedOnBatchId 自关联外键");
    for (const retiredTable of ["WorkHistory", "FeedbackGenerationSelection"]) {
      if (tables.has(retiredTable)) throw new Error(`旧表 ${retiredTable} 未删除`);
    }
    const mismatched = await client.execute(`
      SELECT COUNT(*) AS count
      FROM StudentClassEnrollment e JOIN Class c ON c.id = e.classId
      WHERE c.semesterId <> e.semesterId
    `);
    if (Number(mismatched.rows[0]?.count ?? 0) !== 0) throw new Error("存在跨学期班级归属");
    const duplicate = await client.execute(`SELECT COUNT(*) AS count FROM (SELECT studentId, semesterId, COUNT(*) c FROM StudentClassEnrollment GROUP BY studentId, semesterId HAVING c > 1)`);
    if (Number(duplicate.rows[0]?.count ?? 0) !== 0) throw new Error("同一学生同一学期存在多个归属");
    const integrity = await client.execute("PRAGMA integrity_check");
    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    if (integrity.rows.map((row) => String(row.integrity_check)).join(",") !== "ok" || foreignKeys.rows.length) throw new Error("升级后 SQLite 完整性检查失败");
  } finally {
    client.close();
  }
}

async function migrationNames(projectRoot: string) {
  const directory = path.join(projectRoot, "prisma", "migrations");
  return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function applyMigrationFiles(projectRoot: string, databasePath: string, names: string[]) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    for (const name of names) {
      const sql = await readFile(path.join(projectRoot, "prisma", "migrations", name, "migration.sql"), "utf8");
      await client.executeMultiple(sql);
    }
  } finally {
    client.close();
  }
}

async function seedSyntheticLegacyDatabase(databasePath: string) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    await client.executeMultiple(`
      INSERT INTO "Semester" ("id", "name", "startDate", "endDate", "createdAt") VALUES
        ('semester-old', '固定旧学期', '2026-01-01', '2026-06-30', '2026-01-01T00:00:00.000Z'),
        ('semester-current', '固定当前学期', '2026-07-01', '2026-12-31', '2026-07-01T00:00:00.000Z');
      INSERT INTO "Class" ("id", "code", "name") VALUES
        ('class-shared', 'G3-01', '固定跨学期班'),
        ('class-orphan', 'G3-02', '固定无课次班'),
        ('class-history-only', 'G3-03', '固定仅历史活动当前名单班'),
        ('class-memory-only', 'G3-04', '固定仅记忆班');
      INSERT INTO "Student" ("id", "name", "classId", "studentId", "gender", "rosterStatus", "statusEffectiveAt", "createdAt", "updatedAt") VALUES
        ('student-history', '固定历史学生', 'class-shared', 'FIXED-HISTORY', '女', 'ACTIVE', '2026-07-01T00:00:00.000Z', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z'),
        ('student-inactive', '固定非活跃学生', 'class-shared', 'FIXED-INACTIVE', '男', 'INACTIVE', '2026-07-15T00:00:00.000Z', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z'),
        ('student-transfer', '固定转班学生', 'class-shared', 'FIXED-TRANSFER', '女', 'ACTIVE', '2026-07-15T00:00:00.000Z', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z'),
        ('student-roster-only', '固定当前名单学生', 'class-orphan', 'FIXED-ROSTER', '男', 'ACTIVE', '2026-07-15T00:00:00.000Z', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z'),
        ('student-current-fallback', '固定当前补录学生', 'class-history-only', 'FIXED-CURRENT-FALLBACK', '女', 'ACTIVE', '2026-07-15T00:00:00.000Z', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z');
      INSERT INTO "ClassSession" ("id", "code", "semesterId", "semesterNumber", "date", "classId", "createdAt") VALUES
        ('session-old', '2026030101', 'semester-old', 1, '2026-03-01', 'class-shared', '2026-03-01T00:00:00.000Z'),
        ('session-current', '2026080101', 'semester-current', 1, '2026-08-01', 'class-shared', '2026-08-01T00:00:00.000Z'),
        ('session-history-only', '2026040101', 'semester-old', 2, '2026-04-01', 'class-history-only', '2026-04-01T00:00:00.000Z');
      INSERT INTO "SessionMetric" ("id", "studentId", "date", "scoreA", "scoreB", "scoreC", "scoreD", "operator", "sessionId", "createdAt") VALUES
        ('metric-old', 'student-history', '2026-03-01', 4, 3, 5, 4, 'teacher', 'session-old', '2026-03-01T04:00:00.000Z'),
        ('metric-transfer', 'student-transfer', '2026-08-01', 5, 4, 4, 5, 'teacher', 'session-current', '2026-08-01T04:00:00.000Z');
      INSERT INTO "Attendance" ("id", "sessionId", "studentId", "present", "createdAt") VALUES
        ('attendance-old', 'session-old', 'student-history', 1, '2026-03-01T04:00:00.000Z'),
        ('attendance-inactive', 'session-current', 'student-inactive', 0, '2026-08-01T04:00:00.000Z');
      INSERT INTO "Event" ("id", "studentId", "sessionId", "type", "description", "rawText", "createdAt") VALUES
        ('event-old', 'student-history', 'session-old', '课堂表现', '固定历史表现', '固定历史原始事实', '2026-03-01T04:00:00.000Z');
      INSERT INTO "Communication" ("id", "studentId", "sessionId", "target", "summary", "sourceKey", "createdAt") VALUES
        ('communication-old', 'student-history', 'session-old', '母亲', '固定历史沟通摘要', 'fixed-source-key', '2026-03-01T04:00:00.000Z');
      INSERT INTO "FeedbackPlan" ("id", "type", "purpose", "status", "semesterId", "classId", "sessionId", "inputFingerprint", "planRevision", "createdAt", "updatedAt") VALUES
        ('plan-old', 'class_update', '固定历史反馈计划', 'approved', 'semester-old', 'class-shared', 'session-old', 'fixed-plan-fingerprint', 1, '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z');
      INSERT INTO "FeedbackPlanItem" ("id", "planId", "studentId", "status", "evidenceSnapshot", "compositionSnapshot", "auditSnapshot", "finalText", "finalTextHash", "reviewMode", "itemRevision", "createdAt", "updatedAt") VALUES
        ('plan-item-old', 'plan-old', 'student-history', 'approved', '{"evidence":"固定证据"}', '{"modules":[]}', '{"ok":true}', '固定历史反馈文本', 'fixed-text-hash', 'teacher_edited', 2, '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z');
      INSERT INTO "TeacherTask" ("id", "planId", "planItemId", "studentId", "classId", "action", "dueType", "dueSessionId", "status", "createdAt", "updatedAt") VALUES
        ('task-old', 'plan-old', 'plan-item-old', 'student-history', 'class-shared', '固定历史跟进', 'session', 'session-old', 'pending', '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z');
      INSERT INTO "GenerationRecord" ("id", "taskType", "stage", "lifecycle", "semesterId", "classId", "sessionId", "studentId", "sourceFingerprint", "promptVersion", "modelName", "modelSettings", "sourceRefs", "inputSnapshot", "outputSnapshot", "finalText", "generatedAt", "createdAt", "updatedAt") VALUES
        ('generation-old', 'feedback', 'draft', 'hot', 'semester-old', 'class-shared', 'session-old', 'student-history', 'fixed-generation-fingerprint', 'fixed-prompt', 'fixed-model', '{}', '[]', '{"source":"固定"}', '{"output":"固定"}', '固定生成文本', '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z');
      INSERT INTO "FeedbackGenerationSelection" ("id", "sessionId", "studentId", "selectedGenerationId", "selectedAt", "createdAt", "updatedAt") VALUES
        ('selection-old', 'session-old', 'student-history', 'generation-old', '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z');
      INSERT INTO "TeachingMemory" ("id", "scopeType", "scopeId", "semesterKey", "semesterId", "memoryTier", "status", "content", "sourceFingerprint", "createdAt", "updatedAt") VALUES
        ('memory-old', 'class', 'class-shared', 'semester-old', 'semester-old', 'semester', 'confirmed', '{"summary":"固定旧班记忆"}', 'fixed-memory-fingerprint', '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z'),
        ('memory-only', 'class', 'class-memory-only', 'semester-old', 'semester-old', 'semester', 'confirmed', '{"summary":"固定仅记忆班"}', 'fixed-memory-only-fingerprint', '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z');
      INSERT INTO "MemoryCompactionRun" ("id", "classId", "semesterId", "phase", "status", "sourceFingerprint", "affectedCount", "resultJson", "createdAt", "updatedAt") VALUES
        ('compaction-old', 'class-shared', 'semester-old', 'hot-to-warm', 'succeeded', 'fixed-compaction-fingerprint', 1, '{"summary":"固定压缩"}', '2026-03-01T05:00:00.000Z', '2026-03-01T05:00:00.000Z');
      INSERT INTO "WorkHistory" ("id", "module", "key", "title", "state", "createdAt") VALUES
        ('history-fixed', 'feedback', '2026030101', '固定旧反馈历史', '{"students":[{"id":"student-history","feedback":"固定历史内容"}]}', '2026-03-01T06:00:00.000Z');
      INSERT INTO "SystemLog" ("id", "action", "targetType", "targetId", "targetName", "detail", "createdAt") VALUES
        ('log-fixed', 'score.updated', 'Student', 'student-history', '固定历史学生', '{"source":"fixed"}', '2026-03-01T06:00:00.000Z');
    `);
  } finally {
    client.close();
  }
}

async function seedSynthetic129FeedbackDatabase(databasePath: string) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    await client.executeMultiple(`
      INSERT INTO "Semester" ("id", "name", "startDate", "endDate", "createdAt") VALUES
        ('semester-129', '固定 1.2.9 学期', '2026-07-01', '2026-12-31', '2026-07-01T00:00:00.000Z');
      INSERT INTO "Class" ("id", "semesterId", "code", "name") VALUES
        ('class-129', 'semester-129', 'FIXED-129', '固定 1.2.9 班级');
      INSERT INTO "ClassSession" ("id", "code", "semesterId", "semesterNumber", "date", "classId", "commonMaterialSnapshot", "commonMaterialConfirmedAt", "createdAt") VALUES
        ('session-129', '2026083109', 'semester-129', 9, '2026-08-31', 'class-129', '{"summary":"固定公共材料"}', '2026-08-31T08:00:00.000Z', '2026-08-31T08:00:00.000Z');
      INSERT INTO "FeedbackPlanBatch" (
        "id", "requestKey", "semesterId", "type", "outputRequirement", "generationMode",
        "currentPlanId", "failedPlanId", "sharedLessonRevisionId", "planRevision",
        "createdAt", "updatedAt", "archivedAt"
      ) VALUES (
        'batch-129', 'fixed-129-request', 'semester-129', 'event_micro', '固定批次要求', 'fast',
        'plan-129', NULL, NULL, 7,
        '2026-08-31T08:10:00.000Z', '2026-08-31T08:20:00.000Z', NULL
      );
      INSERT INTO "FeedbackPlan" (
        "id", "type", "outputRequirement", "status", "semesterId", "classId", "sessionId",
        "rangeStartSessionId", "rangeEndSessionId", "inputFingerprint", "inputSnapshot",
        "generationMode", "generationStartedAt", "generationCompletedAt", "generationElapsedMs",
        "generationRunStartedAt", "planRevision", "createdAt", "updatedAt", "approvedAt",
        "exportedAt", "archivedAt", "batchId", "batchOrder"
      ) VALUES (
        'plan-129', 'event_micro', '固定计划要求', 'approved', 'semester-129', 'class-129', 'session-129',
        'session-129', 'session-129', 'fixed-129-fingerprint',
        '{"version":1,"semesterId":"semester-129","classId":"class-129","sessionId":"session-129","sessionCode":"2026083109","sourceFingerprint":"fixed-129-source","lessonMaterial":{"version":1,"groupFeedbackRaw":"固定 V1 班级素材","assessmentBriefRaw":"","lessonTitle":"固定 V1 课程","classroomContent":["固定内容"],"classroomFocus":[],"classroomExplanation":[],"homework":[],"assessmentFocus":[],"correctionAdvice":[],"otherNotes":[]},"generationPreferences":{"closureType":"positive_recognition","moduleKeys":["observed_moment"]}}',
        'fast', '2026-08-31T08:21:00.000Z', '2026-08-31T08:22:00.000Z', 61000,
        '2026-08-31T08:21:01.000Z', 11, '2026-08-31T08:10:00.000Z', '2026-08-31T08:30:00.000Z',
        '2026-08-31T08:25:00.000Z', '2026-08-31T08:30:00.000Z', NULL, 'batch-129', 1
      );
    `);
  } finally {
    client.close();
  }
}

async function assertNamedFeedbackPlanUpgradeSemantics(databasePath: string) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const plans = await client.execute(`
      SELECT displayName, basedOnPlanId, status, inputSnapshot
      FROM FeedbackPlan
      WHERE id = 'plan-129'
    `);
    const plan = plans.rows[0];
    if (!plan) throw new Error("1.2.9 合成计划在升级后丢失");
    if (plan.displayName !== null || plan.basedOnPlanId !== null) throw new Error("旧计划的名称或来源字段默认值不为 NULL");
    if (String(plan.status) !== "approved") throw new Error(`旧计划状态被改写为 ${String(plan.status)}`);
    const snapshot = JSON.parse(String(plan.inputSnapshot)) as { version?: unknown };
    if (snapshot.version !== 1) throw new Error("旧计划的 V1 inputSnapshot 未保留");

    const batches = await client.execute(`
      SELECT displayName, basedOnBatchId, status
      FROM FeedbackPlanBatch
      WHERE id = 'batch-129'
    `);
    const batch = batches.rows[0];
    if (!batch) throw new Error("1.2.9 合成批次在升级后丢失");
    if (batch.displayName !== null || batch.basedOnBatchId !== null) throw new Error("旧批次的名称或来源字段默认值不为 NULL");
    if (String(batch.status) !== "ready") throw new Error(`旧批次状态被改写为 ${String(batch.status)}`);

    await client.execute({
      sql: `
        INSERT INTO FeedbackPlanBatch (
          id, displayName, basedOnBatchId, requestKey, semesterId, type, outputRequirement, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "batch-129-derived",
        "修正批次",
        "batch-129",
        "fixed-129-derived-request",
        "semester-129",
        "event_micro",
        "修正批次要求",
        "2026-08-31T09:00:00.000Z",
      ],
    });
    const derivedBatch = await client.execute(`SELECT status, basedOnBatchId FROM FeedbackPlanBatch WHERE id = 'batch-129-derived'`);
    if (String(derivedBatch.rows[0]?.status) !== "draft") throw new Error("新建 FeedbackPlanBatch 未使用 draft 默认状态");
    if (String(derivedBatch.rows[0]?.basedOnBatchId) !== "batch-129") throw new Error("FeedbackPlanBatch 来源关系未写入");

    await client.execute({
      sql: `
        INSERT INTO FeedbackPlan (
          id, displayName, basedOnPlanId, type, outputRequirement, semesterId, classId,
          sessionId, inputFingerprint, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        "plan-129-derived",
        "修正计划",
        "plan-129",
        "event_micro",
        "修正计划要求",
        "semester-129",
        "class-129",
        "session-129",
        "fixed-129-derived-fingerprint",
        "2026-08-31T09:00:00.000Z",
      ],
    });
    const derivedPlan = await client.execute(`SELECT displayName, basedOnPlanId FROM FeedbackPlan WHERE id = 'plan-129-derived'`);
    if (String(derivedPlan.rows[0]?.displayName) !== "修正计划" || String(derivedPlan.rows[0]?.basedOnPlanId) !== "plan-129") {
      throw new Error("FeedbackPlan 名称或来源关系未写入");
    }
    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    if (foreignKeys.rows.length) throw new Error("命名计划与来源关系写入后 foreign_key_check 失败");
  } finally {
    client.close();
  }
}

async function assertSyntheticSemantics(databasePath: string) {
  const client = createClient({ url: `file:${databasePath}` });
  try {
    const classRows = await client.execute(`SELECT id, semesterId, code FROM Class WHERE code = 'G3-01' ORDER BY semesterId`);
    if (classRows.rows.length !== 2) throw new Error("跨学期班级未拆分为两个实体");
    const currentClass = classRows.rows.find((row) => row.semesterId === "semester-current");
    const oldClass = classRows.rows.find((row) => row.semesterId === "semester-old");
    if (!currentClass || !oldClass || String(currentClass.id) !== "class-shared" || String(oldClass.id) !== "class-shared--semester-old") throw new Error("班级 ID 保留/确定性拆分不符合预期");
    const enrollmentRows = await client.execute(`SELECT studentId, semesterId, classId, rosterStatus FROM StudentClassEnrollment ORDER BY studentId, semesterId`);
    const byKey = new Map(enrollmentRows.rows.map((row) => [`${row.studentId}:${row.semesterId}`, row]));
    if (String(byKey.get("student-history:semester-old")?.classId) !== "class-shared--semester-old") throw new Error("历史学生归属未映射到旧学期班级");
    if (String(byKey.get("student-history:semester-current")?.classId) !== "class-shared" || String(byKey.get("student-history:semester-current")?.rosterStatus) !== "ACTIVE") throw new Error("当前学生归属未继承");
    if (String(byKey.get("student-inactive:semester-current")?.rosterStatus) !== "INACTIVE") throw new Error("非活跃状态未按当前学期继承");
    if (!byKey.has("student-roster-only:semester-current")) throw new Error("无课次名单学生未补当前归属");
    if (!byKey.has("student-current-fallback:semester-current")) throw new Error("仅有历史活动的班级未补当前名单归属");
    const fallbackClasses = await client.execute(`SELECT id, semesterId FROM Class WHERE code = 'G3-03' ORDER BY semesterId`);
    if (fallbackClasses.rows.length !== 2 || !fallbackClasses.rows.some((row) => row.semesterId === "semester-current" && row.id === "class-history-only")) throw new Error("历史班级的当前名单映射不符合预期");
    const sessions = await client.execute(`SELECT id, classId FROM ClassSession ORDER BY id`);
    const sessionMap = new Map(sessions.rows.map((row) => [String(row.id), String(row.classId)]));
    if (sessionMap.get("session-old") !== "class-shared--semester-old" || sessionMap.get("session-current") !== "class-shared") throw new Error("历史课次班级映射错误");
    const memory = await client.execute(`SELECT scopeId, status FROM TeachingMemory WHERE id = 'memory-old'`);
    if (String(memory.rows[0]?.scopeId) !== "class-shared--semester-old" || String(memory.rows[0]?.status) !== "stale") throw new Error("跨学期班级记忆未标记 stale");
    const memoryOnly = await client.execute(`SELECT scopeId FROM TeachingMemory WHERE id = 'memory-only'`);
    if (String(memoryOnly.rows[0]?.scopeId) !== "class-memory-only") throw new Error("仅由教学记忆引用的班级学期映射错误");
    const plans = await client.execute(`SELECT outputRequirement, inputSnapshot, archivedAt FROM FeedbackPlan WHERE id = 'plan-old'`);
    if (String(plans.rows[0]?.outputRequirement) !== "固定历史反馈计划") throw new Error("反馈计划要求字段未从旧 purpose 保留");
    if (String(plans.rows[0]?.inputSnapshot) !== "{}" || plans.rows[0]?.archivedAt !== null) throw new Error("反馈计划新字段默认值不正确");
    const retired = await client.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('WorkHistory', 'FeedbackGenerationSelection')`);
    if (retired.rows.length !== 0) throw new Error("旧反馈历史表仍然存在");
  } finally {
    client.close();
  }
}

async function verifySyntheticUpgrade(projectRoot: string, temporaryDirectory: string) {
  const databasePath = path.join(temporaryDirectory, "synthetic-old.db");
  const names = await migrationNames(projectRoot);
  const migrationName = "20260803123000_add_semester_classes_and_student_enrollments";
  const oldNames = names.filter((name) => name < migrationName);
  const newMigrations = names.filter((name) => name >= migrationName);
  if (!newMigrations.length) throw new Error("找不到学期班级迁移");
  await applyMigrationFiles(projectRoot, databasePath, oldNames);
  await seedSyntheticLegacyDatabase(databasePath);
  const legacyClient = createClient({ url: `file:${databasePath}` });
  const workHistoryCount = await tableRowCount(legacyClient, "WorkHistory");
  legacyClient.close();
  if (workHistoryCount !== 1) throw new Error(`合成旧库 WorkHistory 行数异常：${workHistoryCount}`);
  const before = await inspect(databasePath);
  await applyMigrationFiles(projectRoot, databasePath, newMigrations);
  const after = await inspect(databasePath);
  assertPreserved(before, after, "固定合成旧库");
  await assertNewSchema(databasePath);
  await assertSyntheticSemantics(databasePath);
}

async function verifySynthetic129FeedbackUpgrade(projectRoot: string, temporaryDirectory: string) {
  const databasePath = path.join(temporaryDirectory, "synthetic-1.2.9-feedback.db");
  const names = await migrationNames(projectRoot);
  const migrationName = "20260902150000_add_named_feedback_plan_drafts";
  if (!names.includes(migrationName)) throw new Error("找不到 1.2.10 命名计划迁移");
  await applyMigrationFiles(projectRoot, databasePath, names.filter((name) => name < migrationName));
  await seedSynthetic129FeedbackDatabase(databasePath);
  const before = await inspect(databasePath, FEEDBACK_129_PRESERVED_COLUMNS);
  assertColumnsAvailable(before, FEEDBACK_129_PRESERVED_COLUMNS, "固定 1.2.9 反馈库");
  await applyMigrationFiles(projectRoot, databasePath, names.filter((name) => name >= migrationName));
  const after = await inspect(databasePath, FEEDBACK_129_PRESERVED_COLUMNS);
  assertColumnsAvailable(after, FEEDBACK_129_PRESERVED_COLUMNS, "升级后固定 1.2.9 反馈库");
  assertPreserved(before, after, "固定 1.2.9 反馈库");
  await assertNewSchema(databasePath);
  await assertNamedFeedbackPlanUpgradeSemantics(databasePath);
}

async function verifySynthetic1210FeedbackUpgrade(projectRoot: string, temporaryDirectory: string) {
  const databasePath = path.join(temporaryDirectory, "synthetic-1.2.10-feedback.db");
  const names = await migrationNames(projectRoot);
  const currentMigration = "20260903120000_add_academic_scope_recycle_bin";
  if (!names.includes(currentMigration)) throw new Error("找不到 1.3.0-beta.1 回收站迁移");
  await applyMigrationFiles(projectRoot, databasePath, names.filter((name) => name < currentMigration));
  await seedSynthetic129FeedbackDatabase(databasePath);
  const client = createClient({ url: `file:${databasePath}` });
  try {
    await client.execute(`UPDATE FeedbackPlan SET displayName = '固定 1.2.10 计划' WHERE id = 'plan-129'`);
    await client.execute(`UPDATE FeedbackPlanBatch SET displayName = '固定 1.2.10 批次' WHERE id = 'batch-129'`);
  } finally {
    client.close();
  }
  const before = await inspect(databasePath, FEEDBACK_1210_PRESERVED_COLUMNS);
  assertColumnsAvailable(before, FEEDBACK_1210_PRESERVED_COLUMNS, "固定 1.2.10 反馈库");
  await applyMigrationFiles(projectRoot, databasePath, names.filter((name) => name >= currentMigration));
  const after = await inspect(databasePath, FEEDBACK_1210_PRESERVED_COLUMNS);
  assertColumnsAvailable(after, FEEDBACK_1210_PRESERVED_COLUMNS, "升级后固定 1.2.10 反馈库");
  assertPreserved(before, after, "固定 1.2.10 反馈库");
  await assertNewSchema(databasePath);
}

async function main() {
  const projectRoot = process.cwd();
  const liveDatabase = resolveDatabasePath(process.env.DATABASE_URL ?? "file:./dev.db");
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "student-track-upgrade-"));
  const copiedDatabase = path.join(temporaryDirectory, "upgrade.db");
  try {
    const verifiedLiveCopy = await access(liveDatabase).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (verifiedLiveCopy) {
      await copyFile(liveDatabase, copiedDatabase);
      const prismaCli = path.join(projectRoot, "node_modules", "prisma", "build", "index.js");
      const migration = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
        cwd: projectRoot,
        env: { ...process.env, DATABASE_URL: `file:${copiedDatabase}` },
        stdio: "pipe",
        encoding: "utf8",
      });
      if (migration.status !== 0) {
        const details = [migration.stdout, migration.stderr].map((value) => value.trim()).filter(Boolean).join("\n");
        throw new Error(`数据库副本迁移失败${details ? `：\n${details}` : ""}`);
      }
      const after = await inspect(copiedDatabase);
      if (after.integrity.join(",") !== "ok" || after.foreignKeys.length) throw new Error("真实数据库副本完整性检查失败");
      await assertNewSchema(copiedDatabase);
    }
    await verifySyntheticUpgrade(projectRoot, temporaryDirectory);
    await verifySynthetic129FeedbackUpgrade(projectRoot, temporaryDirectory);
    await verifySynthetic1210FeedbackUpgrade(projectRoot, temporaryDirectory);
    console.log(verifiedLiveCopy
      ? "数据库升级验证通过：全新迁移链、固定合成旧库、固定 1.2.9/1.2.10 反馈库和真实库副本均通过完整性检查；旧反馈计划、批次、V1 快照、状态及其他业务证据未丢失。"
      : "数据库升级验证通过：全新迁移链、固定合成旧库和固定 1.2.9/1.2.10 反馈库通过完整性检查；未发现真实数据库，已跳过副本验证。");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "数据库副本升级验证失败");
  process.exitCode = 1;
});
