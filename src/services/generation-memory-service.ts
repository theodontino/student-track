import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { createLLMClient, getLLMCompletionOptions, getLLMModel } from "@/lib/llm";
import { getEffectiveLLMSettings, type LLMProfileRole } from "@/lib/llm-settings";
import { prisma } from "@/lib/prisma";

export const HOT_SESSION_WINDOW = 5;
export const LONG_TERM_AFTER_DAYS = 183;
export const COMPACTION_UNDO_DAYS = 7;

export type GenerationTaskType = "feedback" | "teaching-summary" | "classroom-parse" | "wecom-prereview" | "wecom-extraction" | "wecom-bridge";
export type GenerationLifecycle = "hot" | "warm" | "purged";
export type MemoryScopeType = "student" | "class";

export interface GenerationSourceRef {
  type: "session" | "student" | "metric" | "attendance" | "event" | "communication" | "draft" | "handoff" | "history" | "generation";
  id: string;
}

export interface RecordSuccessfulGenerationInput {
  taskType: GenerationTaskType;
  stage: string;
  semesterId?: string | null;
  classId?: string | null;
  sessionId?: string | null;
  studentId?: string | null;
  operationKey?: string | null;
  sourceRefs: GenerationSourceRef[];
  promptVersion: string;
  modelRole?: LLMProfileRole | null;
  inputSnapshot?: unknown;
  outputSnapshot: unknown;
  finalText?: string | null;
}

interface StoredWarmItem {
  generationId: string;
  sessionId: string | null;
  taskType: string;
  stage: string;
  generatedAt: string;
  adopted: boolean;
  summary: unknown;
}

interface SemesterMemoryContent {
  version: 1;
  items: StoredWarmItem[];
}

interface LongTermSemesterEvidence {
  semesterMemoryId: string;
  semesterId: string | null;
  effectiveThrough: string | null;
  items: StoredWarmItem[];
  sourceRefs: GenerationSourceRef[];
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function sourceRefJson(refs: GenerationSourceRef[]) {
  return JSON.stringify(refs.filter((item) => item.id));
}

function modelSnapshot(role?: LLMProfileRole | null) {
  const settings = getEffectiveLLMSettings(role ?? undefined);
  return {
    maxTokens: settings.maxTokens ?? null,
    reasoningEnabled: settings.reasoningEnabled ?? false,
    reasoningEffort: settings.reasoningEffort ?? null,
  };
}

function outputSummary(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  // Feedback sections and teaching-summary evidence are already curated, unlike raw prompt context.
  if (record.sections) return { sections: record.sections, reviewStatus: record.reviewStatus ?? null };
  if (record.analysis) return { analysis: record.analysis };
  if (record.parsedResult) return { parsedResult: record.parsedResult, reviewResult: record.reviewResult ?? null };
  const allowed = ["overview", "title", "detail", "status", "result", "students"];
  const compact = Object.fromEntries(allowed.flatMap((key) => key in record ? [[key, record[key]]] : []));
  return Object.keys(compact).length ? compact : { generated: true };
}

function parseMemory(value: string | null): SemesterMemoryContent {
  const parsed = safeJsonParse(value);
  if (!parsed || typeof parsed !== "object") return { version: 1, items: [] };
  const items = Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: StoredWarmItem[] }).items : [];
  return { version: 1, items };
}

function parseSourceRefs(value: string | null | undefined): GenerationSourceRef[] {
  const parsed = safeJsonParse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is GenerationSourceRef => Boolean(
    item
    && typeof item === "object"
    && typeof (item as { type?: unknown }).type === "string"
    && typeof (item as { id?: unknown }).id === "string",
  ));
}

function isoDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export async function recordSuccessfulGeneration(input: RecordSuccessfulGenerationInput, db: PrismaClient = prisma) {
  const settings = modelSnapshot(input.modelRole);
  const inputSnapshot = input.inputSnapshot === undefined ? null : JSON.stringify(input.inputSnapshot);
  const outputSnapshot = JSON.stringify(input.outputSnapshot);
  const sourceFingerprint = fingerprint({ input: input.inputSnapshot ?? null, output: input.outputSnapshot, refs: input.sourceRefs });
  const existing = await db.generationRecord.findFirst({
    where: {
      taskType: input.taskType,
      stage: input.stage,
      lifecycle: "hot",
      semesterId: input.semesterId ?? null,
      classId: input.classId ?? null,
      sessionId: input.sessionId ?? null,
      studentId: input.studentId ?? null,
      sourceFingerprint,
    },
    orderBy: { generatedAt: "desc" },
  });
  const data = {
    taskType: input.taskType,
    stage: input.stage,
    semesterId: input.semesterId ?? null,
    classId: input.classId ?? null,
    sessionId: input.sessionId ?? null,
    studentId: input.studentId ?? null,
    operationKey: input.operationKey ?? null,
    sourceRefs: sourceRefJson(input.sourceRefs),
    sourceFingerprint,
    promptVersion: input.promptVersion,
    modelName: getLLMModel(input.modelRole ?? undefined),
    modelRole: input.modelRole ?? null,
    modelSettings: JSON.stringify(settings),
    inputSnapshot,
    outputSnapshot,
    finalText: input.finalText ?? null,
  };
  if (existing) {
    return db.generationRecord.update({ where: { id: existing.id }, data });
  }
  return db.generationRecord.create({
    data: {
      ...data,
    },
  });
}

export async function markGenerationAdopted(
  generationId: string,
  finalText: string | null,
  db: PrismaClient = prisma,
) {
  return db.generationRecord.update({
    where: { id: generationId },
    data: { finalText, adoptedAt: new Date() },
  });
}

export async function adoptFeedbackGenerationRecords(input: {
  sessionId: string;
  students: Array<{ id: string; feedback: string }>;
}, db: PrismaClient = prisma) {
  const now = new Date();
  await Promise.all(input.students.filter((student) => student.feedback.trim()).map(async (student) => {
    const latest = await db.generationRecord.findFirst({
      where: { taskType: "feedback", sessionId: input.sessionId, studentId: student.id, lifecycle: "hot", stage: { in: ["routine", "review", "draft"] } },
      orderBy: { generatedAt: "desc" },
    });
    if (latest) await db.generationRecord.update({ where: { id: latest.id }, data: { finalText: student.feedback.trim(), adoptedAt: now } });
  }));
}

export async function adoptGenerationByOperationKey(operationKey: string, db: PrismaClient = prisma) {
  return db.generationRecord.updateMany({
    where: { operationKey, lifecycle: "hot" },
    data: { adoptedAt: new Date() },
  });
}

async function completedSessionsForClass(classId: string, db: PrismaClient) {
  const sessions = await db.classSession.findMany({
    where: { classId, date: { lte: isoDay() } },
    orderBy: [{ date: "asc" }, { semesterNumber: "asc" }, { code: "asc" }],
    select: {
      id: true, code: true, date: true, semesterId: true, semesterNumber: true,
      _count: { select: { sessionMetrics: true, attendances: true } },
    },
  });
  const records = await db.generationRecord.findMany({
    where: { classId, sessionId: { not: null }, lifecycle: "hot" },
    select: { sessionId: true },
  });
  const generated = new Set(records.flatMap((row) => row.sessionId ? [row.sessionId] : []));
  return sessions.filter((session) => session._count.sessionMetrics > 0 || session._count.attendances > 0 || generated.has(session.id));
}

function semesterMemoryKey(semesterId: string) {
  return `semester:${semesterId}`;
}

function uniqueRefs(values: GenerationSourceRef[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.type}:${value.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toWarmItem(record: {
  id: string; sessionId: string | null; taskType: string; stage: string; generatedAt: Date; adoptedAt: Date | null; outputSnapshot: string | null;
}): StoredWarmItem {
  return {
    generationId: record.id,
    sessionId: record.sessionId,
    taskType: record.taskType,
    stage: record.stage,
    generatedAt: record.generatedAt.toISOString(),
    adopted: Boolean(record.adoptedAt),
    summary: outputSummary(safeJsonParse(record.outputSnapshot)),
  };
}

async function upsertSemesterMemory(input: {
  scopeType: MemoryScopeType;
  scopeId: string;
  semesterId: string;
  items: StoredWarmItem[];
  sourceRefs: GenerationSourceRef[];
  effectiveThrough: string;
}, db: PrismaClient) {
  const semesterKey = semesterMemoryKey(input.semesterId);
  const existing = await db.teachingMemory.findUnique({
    where: { scopeType_scopeId_semesterKey_memoryTier: { scopeType: input.scopeType, scopeId: input.scopeId, semesterKey, memoryTier: "semester" } },
  });
  const previous = parseMemory(existing?.content ?? null);
  const byGeneration = new Map(previous.items.map((item) => [item.generationId, item]));
  for (const item of input.items) byGeneration.set(item.generationId, item);
  const content: SemesterMemoryContent = { version: 1, items: [...byGeneration.values()].slice(-160) };
  const refs = uniqueRefs([
    ...parseSourceRefs(existing?.sourceRefs),
    ...input.sourceRefs,
  ]);
  const payload = {
    semesterId: input.semesterId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    content,
    sourceRefs: refs,
    effectiveThrough: input.effectiveThrough,
  };
  return db.teachingMemory.upsert({
    where: { scopeType_scopeId_semesterKey_memoryTier: { scopeType: input.scopeType, scopeId: input.scopeId, semesterKey, memoryTier: "semester" } },
    create: {
      scopeType: input.scopeType, scopeId: input.scopeId, semesterKey, semesterId: input.semesterId,
      memoryTier: "semester", status: "confirmed", content: JSON.stringify(content), sourceRefs: sourceRefJson(refs),
      sourceFingerprint: fingerprint(payload), effectiveThrough: input.effectiveThrough,
    },
    update: { content: JSON.stringify(content), sourceRefs: sourceRefJson(refs), sourceFingerprint: fingerprint(payload), effectiveThrough: input.effectiveThrough },
  });
}

/**
 * Deterministically moves records outside the latest five completed class sessions into semester memory.
 * It never calls the LLM and never deletes a source record before the replacement snapshot is committed.
 */
export async function compactHotGenerationRecordsForClass(classId: string, db: PrismaClient = prisma) {
  await clearExpiredCompactionRollbacks(db);
  const sessions = await completedSessionsForClass(classId, db);
  if (sessions.length <= HOT_SESSION_WINDOW) return { compacted: 0, runId: null as string | null };
  const obsolete = sessions.slice(0, -HOT_SESSION_WINDOW);
  const obsoleteIds = obsolete.map((session) => session.id);
  const records = await db.generationRecord.findMany({
    where: {
      classId, sessionId: { in: obsoleteIds }, lifecycle: "hot",
      OR: [
        { taskType: "teaching-summary" },
        { taskType: "feedback", adoptedAt: { not: null } },
        { taskType: "classroom-parse", adoptedAt: { not: null } },
      ],
    },
    orderBy: { generatedAt: "asc" },
  });
  if (!records.length) return { compacted: 0, runId: null as string | null };
  const runFingerprint = fingerprint({ phase: "hot-to-warm", classId, records: records.map((record) => record.id) });
  const previousRun = await db.memoryCompactionRun.findUnique({ where: { classId_phase_sourceFingerprint: { classId, phase: "hot-to-warm", sourceFingerprint: runFingerprint } } });
  if (previousRun?.status === "succeeded") return { compacted: 0, runId: previousRun.id };

  const run = previousRun ?? await db.memoryCompactionRun.create({
    data: { classId, semesterId: obsolete.at(-1)?.semesterId ?? null, fromSessionId: obsolete[0]?.id ?? null, toSessionId: obsolete.at(-1)?.id ?? null, phase: "hot-to-warm", sourceFingerprint: runFingerprint, affectedCount: records.length, status: "running" },
  });
  if (previousRun) await db.memoryCompactionRun.update({ where: { id: run.id }, data: { status: "running", failureCode: null } });

  try {
    const rollbackPayload = records.map((record) => ({ id: record.id, inputSnapshot: record.inputSnapshot, outputSnapshot: record.outputSnapshot, finalText: record.finalText, lifecycle: record.lifecycle, warmSnapshot: record.warmSnapshot, compactedAt: record.compactedAt }));
    const grouped = new Map<string, typeof records>();
    for (const record of records) {
      const key = record.studentId ?? `class:${record.semesterId ?? "unknown"}`;
      grouped.set(key, [...(grouped.get(key) ?? []), record]);
    }
    for (const [key, values] of grouped) {
      const scopeType: MemoryScopeType = key.startsWith("class:") ? "class" : "student";
      const scopeId = scopeType === "class" ? classId : key;
      const semesterId = values[0]?.semesterId;
      if (!semesterId) continue;
      const refs = uniqueRefs(values.flatMap((record) => parseSourceRefs(record.sourceRefs)));
      await upsertSemesterMemory({ scopeType, scopeId, semesterId, items: values.map(toWarmItem), sourceRefs: refs, effectiveThrough: obsolete.at(-1)?.code ?? "" }, db);
    }
    const now = new Date();
    const warmPayload = JSON.stringify({ version: 1, compactedFrom: obsolete.map((session) => session.code), recordCount: records.length });
    await db.$transaction([
      db.generationRecord.updateMany({ where: { id: { in: records.map((record) => record.id) } }, data: { lifecycle: "warm", inputSnapshot: null, outputSnapshot: null, finalText: null, warmSnapshot: warmPayload, compactedAt: now } }),
      db.memoryCompactionRun.update({ where: { id: run.id }, data: { status: "succeeded", rollbackPayload: JSON.stringify(rollbackPayload), undoUntil: new Date(now.getTime() + COMPACTION_UNDO_DAYS * 86400000), completedAt: now, resultJson: warmPayload } }),
    ]);
    return { compacted: records.length, runId: run.id };
  } catch (error) {
    await db.memoryCompactionRun.update({ where: { id: run.id }, data: { status: "failed", failureCode: "compaction_failed" } }).catch(() => undefined);
    throw error;
  }
}

export async function undoHotToWarmCompaction(runId: string, db: PrismaClient = prisma) {
  const run = await db.memoryCompactionRun.findUnique({ where: { id: runId } });
  if (!run || run.phase !== "hot-to-warm" || run.status !== "succeeded" || !run.rollbackPayload || !run.undoUntil || run.undoUntil < new Date()) {
    throw new Error("该压缩记录无法撤销");
  }
  const entries = safeJsonParse(run.rollbackPayload);
  if (!Array.isArray(entries)) throw new Error("撤销数据无效");
  const restoredIds = entries.flatMap((entry) => {
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
  await db.$transaction(entries.map((entry) => {
    const value = entry as { id?: string; inputSnapshot?: string | null; outputSnapshot?: string | null; finalText?: string | null; lifecycle?: string; warmSnapshot?: string | null; compactedAt?: Date | null };
    return db.generationRecord.update({ where: { id: value.id }, data: { lifecycle: value.lifecycle ?? "hot", inputSnapshot: value.inputSnapshot ?? null, outputSnapshot: value.outputSnapshot ?? null, finalText: value.finalText ?? null, warmSnapshot: value.warmSnapshot ?? null, compactedAt: value.compactedAt ?? null } });
  }));
  const semesterMemories = await db.teachingMemory.findMany({ where: { memoryTier: "semester" } });
  await Promise.all(semesterMemories.map(async (memory) => {
    const content = parseMemory(memory.content);
    const nextItems = content.items.filter((item) => !restoredIds.includes(item.generationId));
    if (nextItems.length === content.items.length) return;
    await db.teachingMemory.update({
      where: { id: memory.id },
      data: { content: JSON.stringify({ version: 1, items: nextItems }), updatedAt: new Date() },
    });
  }));
  await db.memoryCompactionRun.update({ where: { id: runId }, data: { status: "undone", rollbackPayload: null, completedAt: new Date() } });
}

export async function clearExpiredCompactionRollbacks(db: PrismaClient = prisma) {
  return db.memoryCompactionRun.updateMany({
    where: { phase: "hot-to-warm", status: "succeeded", undoUntil: { lt: new Date() }, rollbackPayload: { not: null } },
    data: { rollbackPayload: null },
  });
}

function hasReliableSummary(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.some(hasReliableSummary);
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "generated" && key !== "reviewStatus");
  return entries.some(([, item]) => hasReliableSummary(item));
}

function semesterEvidenceForRecords(input: {
  rows: Array<{ id: string; semesterId: string | null }>;
  memories: Array<{
    id: string;
    semesterId: string | null;
    content: string;
    sourceRefs: string;
    effectiveThrough: string | null;
  }>;
}): LongTermSemesterEvidence[] {
  const generationIds = new Set(input.rows.map((row) => row.id));
  const semesterIds = new Set(input.rows.flatMap((row) => row.semesterId ? [row.semesterId] : []));
  return input.memories.flatMap((memory) => {
    if (!memory.semesterId || !semesterIds.has(memory.semesterId)) return [];
    const items = parseMemory(memory.content).items
      .filter((item) => generationIds.has(item.generationId) && hasReliableSummary(item.summary));
    if (!items.length) return [];
    return [{
      semesterMemoryId: memory.id,
      semesterId: memory.semesterId,
      effectiveThrough: memory.effectiveThrough,
      items,
      sourceRefs: parseSourceRefs(memory.sourceRefs),
    }];
  });
}

/** Generates one constrained class batch of long-term memory drafts when warm records become six months old. */
export async function generateLongTermMemoryDraftsForClass(classId: string, db: PrismaClient = prisma) {
  await clearExpiredCompactionRollbacks(db);
  const cutoff = new Date(Date.now() - LONG_TERM_AFTER_DAYS * 86400000).toISOString().slice(0, 10);
  const sessions = await db.classSession.findMany({ where: { classId, date: { lte: cutoff } }, select: { id: true, semesterId: true, code: true } });
  const sessionIds = sessions.map((session) => session.id);
  if (!sessionIds.length) return { drafts: 0, skipped: true, reason: "no_eligible_sessions", runId: null as string | null, skippedScopes: 0 };
  const records = await db.generationRecord.findMany({
    where: { classId, lifecycle: "warm", sessionId: { in: sessionIds } },
    orderBy: [{ generatedAt: "asc" }, { id: "asc" }],
  });
  if (!records.length) return { drafts: 0, skipped: true, reason: "no_eligible_warm_records", runId: null as string | null, skippedScopes: 0 };
  const grouped = new Map<string, typeof records>();
  for (const record of records) {
    const key = record.studentId ?? `class:${classId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  const studentScopeIds = [...grouped.keys()].filter((scopeId) => !scopeId.startsWith("class:"));
  const semesterMemories = await db.teachingMemory.findMany({
    where: {
      memoryTier: "semester",
      status: "confirmed",
      OR: [
        { scopeType: "class", scopeId: classId },
        ...(studentScopeIds.length ? [{ scopeType: "student", scopeId: { in: studentScopeIds } }] : []),
      ],
    },
    select: { id: true, scopeType: true, scopeId: true, semesterId: true, content: true, sourceRefs: true, effectiveThrough: true },
    orderBy: { id: "asc" },
  });
  const existingLongTerm = await db.teachingMemory.findMany({
    where: {
      memoryTier: "long-term",
      semesterKey: "long-term",
      OR: [
        { scopeType: "class", scopeId: classId },
        ...(studentScopeIds.length ? [{ scopeType: "student", scopeId: { in: studentScopeIds } }] : []),
      ],
    },
  });
  const previousByScope = new Map(existingLongTerm.map((memory) => [`${memory.scopeType}:${memory.scopeId}`, memory]));
  const candidates = [...grouped.entries()].map(([groupKey, rows]) => {
    const scopeType: MemoryScopeType = groupKey.startsWith("class:") ? "class" : "student";
    const scopeId = scopeType === "class" ? classId : groupKey;
    const evidence = semesterEvidenceForRecords({
      rows,
      memories: semesterMemories.filter((memory) => memory.scopeType === scopeType && memory.scopeId === scopeId),
    });
    const generationIds = uniqueRefs(evidence.flatMap((entry) => entry.items.map((item) => ({ type: "generation" as const, id: item.generationId }))))
      .map((item) => item.id);
    const previous = previousByScope.get(`${scopeType}:${scopeId}`);
    return {
      scopeType,
      scopeId,
      evidence,
      generationIds,
      previousConfirmedBackground: previous?.status === "confirmed" ? previous.content : null,
    };
  });
  const eligible = candidates.filter((item) => item.evidence.length && item.generationIds.length);
  const payload = eligible.map((item, index) => ({
    ref: `M${String(index + 1).padStart(3, "0")}`,
    scopeType: item.scopeType,
    scopeId: item.scopeId,
    semesterSummaries: item.evidence,
    previousConfirmedBackground: item.previousConfirmedBackground,
    generationIds: item.generationIds,
  }));
  const skippedScopes = candidates.length - payload.length;
  if (!payload.length) {
    return { drafts: 0, skipped: true, reason: "no_reliable_semester_summary", runId: null as string | null, skippedScopes };
  }
  const sourceFingerprint = fingerprint(payload);
  const previousRun = await db.memoryCompactionRun.findUnique({
    where: { classId_phase_sourceFingerprint: { classId, phase: "warm-to-long", sourceFingerprint } },
  });
  if (previousRun?.status === "succeeded") {
    return { drafts: 0, skipped: true, reason: "already_processed", runId: previousRun.id, skippedScopes };
  }
  const run = previousRun ?? await db.memoryCompactionRun.create({
    data: {
      classId,
      semesterId: sessions.at(-1)?.semesterId ?? null,
      fromSessionId: sessions[0]?.id ?? null,
      toSessionId: sessions.at(-1)?.id ?? null,
      phase: "warm-to-long",
      sourceFingerprint,
      affectedCount: payload.reduce((count, item) => count + item.generationIds.length, 0),
      status: "running",
    },
  });
  if (previousRun) {
    await db.memoryCompactionRun.update({
      where: { id: run.id },
      data: { status: "running", failureCode: null, completedAt: null },
    });
  }
  try {
    const client = createLLMClient();
    const model = getLLMModel();
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      ...getLLMCompletionOptions(undefined, 2048),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "你是教师内部教学档案助手。只根据输入的受控学期摘要和教师此前确认的背景，写极短、可长期保留的背景。不得评价人格、不得写续班或内部风险、不得补充未给出的事实。每项最多 120 字。只返回 JSON。" },
        { role: "user", content: `返回 {"items":[{"ref":"M001","text":"..."}]}。每个 ref 必须来自输入，不能遗漏或新增。semesterSummaries.items.summary 是唯一可采用的新事实证据；不要把 ID、计数或压缩元数据改写成教学结论。\n${JSON.stringify(payload)}` },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? "";
    let parsed: { items?: Array<{ ref?: string; text?: string }> } = {};
    try { parsed = JSON.parse(raw) as typeof parsed; } catch { throw new Error("long_term_memory_invalid"); }
    const result = new Map((parsed.items ?? []).flatMap((item) => typeof item.ref === "string" && typeof item.text === "string" ? [[item.ref, item.text.trim()]] : []));
    if (result.size !== payload.length || payload.some((item) => !result.get(item.ref))) throw new Error("long_term_memory_invalid");
    const now = new Date();
    const resultJson = JSON.stringify({ drafts: payload.length, skippedScopes });
    await db.$transaction([
      ...payload.map((item) => {
        const text = result.get(item.ref) ?? "";
        const previous = previousByScope.get(`${item.scopeType}:${item.scopeId}`);
        const refs = uniqueRefs([
          ...parseSourceRefs(previous?.sourceRefs),
          ...item.semesterSummaries.flatMap((entry) => entry.sourceRefs),
          ...item.generationIds.map((id) => ({ type: "generation" as const, id })),
        ]);
        return db.teachingMemory.upsert({
          where: { scopeType_scopeId_semesterKey_memoryTier: { scopeType: item.scopeType, scopeId: item.scopeId, semesterKey: "long-term", memoryTier: "long-term" } },
          create: { scopeType: item.scopeType, scopeId: item.scopeId, semesterKey: "long-term", memoryTier: "long-term", status: "draft", content: text, sourceRefs: sourceRefJson(refs), sourceFingerprint, generatedAt: now },
          update: { status: "draft", content: text, sourceRefs: sourceRefJson(refs), sourceFingerprint, generatedAt: now, confirmedAt: null },
        });
      }),
      db.memoryCompactionRun.update({
        where: { id: run.id },
        data: { status: "succeeded", completedAt: now, resultJson },
      }),
    ]);
    return { drafts: payload.length, skipped: false, reason: null, runId: run.id, skippedScopes };
  } catch (error) {
    await db.memoryCompactionRun.update({
      where: { id: run.id },
      data: { status: "failed", failureCode: error instanceof Error ? error.message.slice(0, 120) : "long_term_memory_failed", completedAt: new Date() },
    }).catch(() => undefined);
    throw error;
  }
}

export async function confirmLongTermMemory(id: string, content: string, db: PrismaClient = prisma) {
  const memory = await db.teachingMemory.findUnique({ where: { id } });
  if (!memory || memory.memoryTier !== "long-term") throw new Error("长期背景不存在");
  const confirmedContent = content.trim();
  if (!confirmedContent) throw new Error("长期背景不能为空");
  const generationIds = parseSourceRefs(memory.sourceRefs)
    .filter((item) => item.type === "generation")
    .map((item) => item.id);
  const now = new Date();
  const [confirmed] = await db.$transaction([
    db.teachingMemory.update({ where: { id }, data: { content: confirmedContent, status: "confirmed", confirmedAt: now } }),
    ...(generationIds.length ? [db.generationRecord.updateMany({
      where: { id: { in: generationIds }, lifecycle: "warm" },
      data: { lifecycle: "purged", warmSnapshot: null, purgedAt: now },
    })] : []),
  ]);
  return confirmed;
}

export async function listGenerationHistory(input: { studentId?: string; classId?: string; limit?: number }, db: PrismaClient = prisma) {
  return db.generationRecord.findMany({ where: { ...(input.studentId ? { studentId: input.studentId } : {}), ...(input.classId ? { classId: input.classId } : {}) }, orderBy: { generatedAt: "desc" }, take: Math.min(Math.max(input.limit ?? 80, 1), 200) });
}

export async function getConfirmedTeachingMemory(input: { studentId?: string; classId?: string; semesterId?: string }, db: PrismaClient = prisma) {
  const filters = [
    input.studentId ? { scopeType: "student", scopeId: input.studentId } : null,
    input.classId ? { scopeType: "class", scopeId: input.classId } : null,
  ].filter((value): value is { scopeType: string; scopeId: string } => Boolean(value));
  if (!filters.length) return [];
  return db.teachingMemory.findMany({
    where: { OR: filters, status: "confirmed", ...(input.semesterId ? { OR: [...filters.map((filter) => ({ ...filter, semesterId: input.semesterId })), ...filters.map((filter) => ({ ...filter, semesterKey: "long-term" }))] } : {}) },
    orderBy: { updatedAt: "desc" },
  });
}
