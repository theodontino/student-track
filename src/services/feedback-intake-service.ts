import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ParsedStudent } from "@/lib/parser";
import type { DraftStructuredResult } from "@/lib/types";
import { completeClassAttendance } from "@/lib/nlAttendance";
import { parseAssistantRosterFiles } from "@/services/assistant-roster-import-service";
import { parseStepClassroomEnvelope, createStepObservationOnlyResult } from "@/services/step-classroom-import-service";
import { parseAssessmentPdf } from "@/services/assessment-pdf-service";
import { processDraftReview } from "@/services/review-service";
import { createFeedbackPlan, getFeedbackPlan } from "@/services/feedback-plan-service";
import type { FeedbackPlanCreateInput } from "@/lib/feedback-plan";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";
import { lessonMaterialHasContent } from "@/lib/feedback-materials";
import { prisma } from "@/lib/prisma";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 200;
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;

type IntakeSource = "upload" | "inbox";
type IntakeKind = "assistant_roster" | "step_classroom" | "assessment_pdf";

export interface IntakeFile {
  name: string;
  buffer: ArrayBuffer;
  source: IntakeSource;
}

interface ExpandedFile extends IntakeFile {
  displayName: string;
}

export interface FeedbackIntakeIssue {
  id: string;
  code: string;
  message: string;
  sourceName?: string;
  severity: "requires_teacher" | "error";
}

export interface FeedbackIntakeSummary {
  sourceCount: number;
  recognizedCount: number;
  ignoredCount: number;
  assistantFileCount: number;
  stepFileCount: number;
  assessmentFileCount: number;
  appliedStudentCount: number;
  assessmentStudentCount: number;
  issueCount: number;
}

export interface FeedbackIntakeInspection {
  sessionCode: string;
  sourceFingerprint: string;
  sourceManifest: Array<{ name: string; source: IntakeSource; kind: IntakeKind | "ignored"; size: number }>;
  parsedResult: DraftStructuredResult;
  assessmentEvidence: Record<string, unknown>;
  issues: FeedbackIntakeIssue[];
  summary: FeedbackIntakeSummary;
}

export interface FeedbackIntakeRunView {
  id: string;
  sessionCode: string;
  status: string;
  sourceFingerprint: string;
  sourceManifest: Array<Record<string, unknown>>;
  appliedSummary: Record<string, unknown>;
  issues: FeedbackIntakeIssue[];
  planId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array) {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function extension(name: string) {
  return path.extname(name).toLocaleLowerCase();
}

function safeArchiveName(name: string) {
  const normalized = name.replaceAll("\\", "/");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").some((part) => part === ".." || part === "");
}

function zipError(message: string): never {
  throw new Error(`ZIP：${message}`);
}

function expandZip(file: IntakeFile): ExpandedFile[] {
  const buffer = Buffer.from(file.buffer);
  const searchStart = Math.max(0, buffer.length - 65_557);
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), buffer.length - 4);
  if (endOffset < searchStart) zipError("缺少结束目录，文件可能损坏");
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (entryCount > MAX_ZIP_ENTRIES) zipError(`条目超过 ${MAX_ZIP_ENTRIES} 个`);
  const result: ExpandedFile[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER) zipError("中央目录格式无效");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (!safeArchiveName(name)) zipError(`路径无效：${name}`);
    if (extension(name) === ".zip") zipError("不支持嵌套 ZIP");
    if (flags & 0x1) zipError("不支持加密 ZIP");
    if (uncompressedSize > MAX_FILE_BYTES) zipError(`文件过大：${name}`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) zipError("本地文件头格式无效");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    if (method === 0) content = compressed;
    else if (method === 8) content = inflateRawSync(compressed);
    else zipError(`不支持的压缩方式：${method}`);
    if (content.length > MAX_FILE_BYTES) zipError(`解压后文件过大：${name}`);
    result.push({ name, displayName: `${file.name} / ${name}`, buffer: toArrayBuffer(content), source: file.source });
  }
  return result;
}

function expandFiles(files: IntakeFile[], expansionIssues?: FeedbackIntakeIssue[]) {
  const expanded: ExpandedFile[] = [];
  for (const file of files) {
    try {
      if (file.buffer.byteLength > MAX_FILE_BYTES) throw new Error(`文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB：${file.name}`);
      if (extension(file.name) === ".zip") expanded.push(...expandZip(file));
      else expanded.push({ ...file, displayName: file.name });
    } catch (error) {
      if (!expansionIssues) throw error;
      expansionIssues.push(issue("zip_invalid", error instanceof Error ? error.message : "压缩文件无法读取", file.name, "error"));
      expanded.push({ ...file, displayName: file.name });
    }
  }
  return expanded;
}

export function expandFeedbackIntakeFiles(files: IntakeFile[]) {
  return expandFiles(files);
}

function classify(file: ExpandedFile): IntakeKind | "ignored" {
  const lower = file.name.toLocaleLowerCase();
  if (lower.endsWith(".xlsx")) return "assistant_roster";
  if (lower.endsWith(".step-classroom.txt") || lower.endsWith(".txt") || lower.endsWith(".md")) return "step_classroom";
  if (lower.endsWith(".pdf")) return "assessment_pdf";
  return "ignored";
}

export function classifyFeedbackIntakeFile(name: string): IntakeKind | "ignored" {
  return classify({ name, displayName: name, buffer: new ArrayBuffer(0), source: "upload" });
}

function issue(code: string, message: string, sourceName?: string, severity: FeedbackIntakeIssue["severity"] = "requires_teacher"): FeedbackIntakeIssue {
  return { id: `${code}:${sourceName ?? "run"}:${Math.random().toString(36).slice(2, 8)}`, code, message, ...(sourceName ? { sourceName } : {}), severity };
}

function normalizeDraftStudent(value: ParsedStudent): DraftStructuredResult["students"][number] {
  return {
    name: value.name,
    ...(value.studentId ? { studentId: value.studentId } : {}),
    scores: value.scores,
    events: value.events,
    communication: null,
    ...(value.present === undefined ? {} : { present: value.present }),
    ...(value.teacherInterventions?.length ? { teacherInterventions: value.teacherInterventions } : {}),
    attentionSignals: [],
  };
}

async function readInboxFiles() {
  const root = process.env.STUDENT_TRACK_FEEDBACK_INBOX_ROOT?.trim()
    || path.join(os.homedir(), "Library", "Application Support", "Student Track", "feedback-inbox");
  const result: IntakeFile[] = [];
  async function visit(directory: string) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("读取反馈收件箱失败");
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        const buffer = await fs.readFile(target);
        result.push({ name: entry.name, buffer: toArrayBuffer(buffer), source: "inbox" });
      }
    }
  }
  await visit(root);
  return result;
}

async function loadSession(db: PrismaClient, sessionCode: string) {
  const session = await db.classSession.findUnique({
    where: { code: sessionCode },
    include: { class: { select: { id: true, code: true, name: true } } },
  });
  if (!session?.classId || !session.class) throw new Error("课次不存在或未关联班级");
  const roster = await db.student.findMany({
    where: { enrollments: { some: { semesterId: session.semesterId, classId: session.classId, rosterStatus: "ACTIVE" } } },
    select: { id: true, name: true, studentId: true },
    orderBy: { studentId: "asc" },
  });
  if (!roster.length) throw new Error("当前课次班级没有 ACTIVE 学生");
  return { session, roster };
}

function addStudent(target: Map<string, ParsedStudent>, student: ParsedStudent) {
  const existing = target.get(student.name);
  if (!existing) { target.set(student.name, student); return; }
  target.set(student.name, {
    ...existing,
    scores: {
      A: student.scores.A ?? existing.scores.A,
      B: student.scores.B ?? existing.scores.B,
      C: student.scores.C ?? existing.scores.C,
    },
    events: [...new Set([...existing.events, ...student.events])],
    ...(student.present !== undefined ? { present: student.present } : {}),
    teacherInterventions: [...(existing.teacherInterventions ?? []), ...(student.teacherInterventions ?? [])],
  });
}

function manifestFor(files: ExpandedFile[]) {
  return files.map((file) => ({ name: file.displayName, source: file.source, kind: classify(file), size: file.buffer.byteLength }));
}

export async function inspectFeedbackIntake(input: { sessionCode: string; files: IntakeFile[]; db?: PrismaClient }): Promise<FeedbackIntakeInspection> {
  const db = input.db ?? prisma;
  const { session, roster } = await loadSession(db, input.sessionCode);
  const classInfo = session.class;
  if (!classInfo) throw new Error("课次不存在或未关联班级");
  const expansionIssues: FeedbackIntakeIssue[] = [];
  const expanded = expandFiles(input.files, expansionIssues);
  const manifest = manifestFor(expanded);
  const sourceFingerprint = sha256(JSON.stringify({ sessionCode: input.sessionCode, files: expanded.map((file) => ({ name: file.displayName, source: file.source, size: file.buffer.byteLength, sha256: sha256(new Uint8Array(file.buffer)) })) }));
  const issues: FeedbackIntakeIssue[] = [...expansionIssues];
  const byName = new Map(roster.map((student) => [student.name, student]));
  const byStudentId = new Map(roster.map((student) => [student.studentId, student]));
  const merged = new Map<string, ParsedStudent>();
  const assistantFiles = expanded.filter((file) => classify(file) === "assistant_roster");
  const stepFiles = expanded.filter((file) => classify(file) === "step_classroom");
  const assessmentFiles = expanded.filter((file) => classify(file) === "assessment_pdf");

  if (assistantFiles.length) {
    const rows = parseAssistantRosterFiles(await Promise.all(assistantFiles.map(async (file) => ({ name: file.displayName, buffer: toArrayBuffer(file.buffer) }))));
    const targetRows = rows.filter((row) => row.classCode === classInfo.code || row.className === classInfo.name);
    if (!targetRows.length) issues.push(issue("assistant_class_mismatch", `助教表中没有找到 ${classInfo.name ?? classInfo.code} 的课堂记录`, assistantFiles[0]?.displayName));
    const seen = new Set<string>();
    for (const row of targetRows) {
      const match = (row.studentId ? byStudentId.get(row.studentId) : undefined) ?? byName.get(row.name);
      if (!match) { issues.push(issue("student_mismatch", `${row.fileName} 第 ${row.rowNumber} 行无法匹配当前班级学生`, row.fileName)); continue; }
      if (seen.has(match.id)) { issues.push(issue("duplicate_student", `${match.name} 在助教表中重复出现，已保留第一条`, row.fileName)); continue; }
      seen.add(match.id);
      addStudent(merged, { name: match.name, studentId: match.studentId, scores: { A: row.scoreA, B: row.scoreB, C: row.scoreC }, events: row.note ? [row.note] : [], communication: null, present: true });
    }
    const completed = completeClassAttendance({ students: [...merged.values()], alert_suggestion: "" }, roster);
    merged.clear();
    completed.students.forEach((student) => merged.set(student.name, student));
  }

  for (const file of stepFiles) {
    try {
      const envelope = parseStepClassroomEnvelope(Buffer.from(file.buffer).toString("utf8"));
      if (envelope.payload.class.code !== classInfo.code) {
        issues.push(issue("step_class_mismatch", `STEP 班级 ${envelope.payload.class.code} 与当前课次班级不一致`, file.displayName, "error"));
        continue;
      }
      const completedAt = envelope.payload.completedAt;
      if (!completedAt) {
        issues.push(issue("step_date_missing", "STEP 缺少完成日期，无法自动匹配课次", file.displayName));
      } else if (completedAt.slice(0, 10) !== session.date) {
        issues.push(issue("step_date_mismatch", `STEP 完成日期 ${completedAt.slice(0, 10)} 与课次日期 ${session.date} 不一致`, file.displayName));
      }
      const stepResult = createStepObservationOnlyResult(envelope.payload);
      for (const student of stepResult.students) {
        const match = byStudentId.get(student.studentId ?? "");
        if (!match || match.name !== student.name) { issues.push(issue("step_student_mismatch", `STEP 学号 ${student.studentId ?? ""} 与当前花名册不一致`, file.displayName, "error")); continue; }
        const sourceStudent = envelope.payload.students.find((item) => item.studentId === student.studentId);
        const interventions = student.teacherInterventions ?? [];
        const previous = merged.get(match.name);
        if (previous?.present !== undefined && sourceStudent && previous.present !== sourceStudent.present) {
          issues.push(issue("attendance_conflict", `${match.name} 的助教表与 STEP 考勤结论冲突，该学生考勤暂不自动写入`, file.displayName));
          const withoutPresent = { ...previous, present: undefined };
          merged.set(match.name, { ...withoutPresent, teacherInterventions: [...(previous.teacherInterventions ?? []), ...interventions] });
        } else {
          addStudent(merged, { name: match.name, studentId: match.studentId, scores: { A: null, B: null, C: null }, events: [], communication: null, ...(sourceStudent ? { present: sourceStudent.present } : {}), teacherInterventions: interventions });
        }
      }
    } catch (error) {
      issues.push(issue("step_invalid", error instanceof Error ? error.message : "STEP 文件无法解析", file.displayName, "error"));
    }
  }

  const assessmentEvidence: Record<string, unknown> = {};
  const assessmentSeen = new Set<string>();
  for (const file of assessmentFiles) {
    try {
      const parsed = await parseAssessmentPdf(toArrayBuffer(file.buffer), file.displayName);
      const matchById = parsed.reportStudentId ? byStudentId.get(parsed.reportStudentId) : undefined;
      const matchByName = parsed.reportStudentName ? byName.get(parsed.reportStudentName) : undefined;
      if (matchById && matchByName && matchById.id !== matchByName.id) {
        issues.push(issue("assessment_identity_conflict", "PDF 内姓名和学号对应不同学生", file.displayName)); continue;
      }
      const match = matchById ?? matchByName;
      if (!match) { issues.push(issue("assessment_needs_match", "PDF 未能唯一匹配当前班级学生", file.displayName)); continue; }
      if (assessmentSeen.has(match.id)) { issues.push(issue("assessment_duplicate", `${match.name} 存在多份 PDF，已保留第一份`, file.displayName)); continue; }
      assessmentSeen.add(match.id);
      assessmentEvidence[match.id] = { ...parsed.evidence, sourceType: "assessment_pdf", sessionCode: input.sessionCode, studentId: match.id };
    } catch (error) {
      issues.push(issue("assessment_invalid", error instanceof Error ? error.message : "PDF 无法解析", file.displayName));
    }
  }

  const recognized = manifest.filter((entry) => entry.kind !== "ignored").length;
  const result = {
    students: [...merged.values()].map(normalizeDraftStudent),
    alert_suggestion: "",
  } satisfies DraftStructuredResult;
  return {
    sessionCode: input.sessionCode,
    sourceFingerprint,
    sourceManifest: manifest,
    parsedResult: result,
    assessmentEvidence,
    issues,
    summary: {
      sourceCount: input.files.length,
      recognizedCount: recognized,
      ignoredCount: manifest.length - recognized,
      assistantFileCount: assistantFiles.length,
      stepFileCount: stepFiles.length,
      assessmentFileCount: assessmentFiles.length,
      appliedStudentCount: result.students.length,
      assessmentStudentCount: Object.keys(assessmentEvidence).length,
      issueCount: issues.length,
    },
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

async function confirmedMaterialForSession(sessionId: string, db: PrismaClient) {
  const link = await db.groupLessonSession.findUnique({
    where: { sessionId },
    include: { groupLesson: { include: { revisions: { orderBy: { revision: "desc" }, take: 1 } } } },
  });
  const raw = link?.groupLesson.revisions[0]?.materialSnapshot;
  if (!raw) return null;
  const parsed = LessonFeedbackMaterialSchema.safeParse(parseJson(raw, null));
  return parsed.success ? parsed.data : null;
}

function view(run: { id: string; sessionCode: string; status: string; sourceFingerprint: string; sourceManifest: string; appliedSummary: string; issues: string; planId: string | null; createdAt: Date; updatedAt: Date }): FeedbackIntakeRunView {
  return {
    id: run.id,
    sessionCode: run.sessionCode,
    status: run.status,
    sourceFingerprint: run.sourceFingerprint,
    sourceManifest: parseJson(run.sourceManifest, []),
    appliedSummary: parseJson(run.appliedSummary, {}),
    issues: parseJson(run.issues, []),
    planId: run.planId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export async function getFeedbackIntakeRun(id: string, db: PrismaClient = prisma) {
  const run = await db.feedbackIntakeRun.findUnique({ where: { id } });
  return run ? view(run) : null;
}

export async function createOrGetFeedbackIntakeRun(input: { sessionCode: string; files: IntakeFile[]; db?: PrismaClient }) {
  const db = input.db ?? prisma;
  const inspection = await inspectFeedbackIntake(input);
  const existing = await db.feedbackIntakeRun.findUnique({ where: { sourceFingerprint: inspection.sourceFingerprint } });
  if (existing) return { run: view(existing), inspection, duplicate: true };
  const run = await db.feedbackIntakeRun.create({
    data: {
      sessionCode: input.sessionCode,
      sourceFingerprint: inspection.sourceFingerprint,
      sourceManifest: JSON.stringify(inspection.sourceManifest),
      status: inspection.issues.length ? "needs_review" : "ready",
      issues: JSON.stringify(inspection.issues),
      appliedSummary: JSON.stringify({ ...inspection.summary, parsedResult: inspection.parsedResult, assessmentEvidence: inspection.assessmentEvidence }),
    },
  });
  return { run: view(run), inspection, duplicate: false };
}

export async function applyFeedbackIntakeRun(id: string, db: PrismaClient = prisma) {
  const run = await db.feedbackIntakeRun.findUnique({ where: { id } });
  if (!run) throw new Error("反馈材料运行不存在");
  const snapshot = parseJson<{ parsedResult?: DraftStructuredResult; assessmentEvidence?: Record<string, unknown>; [key: string]: unknown }>(run.appliedSummary, {});
  if (run.status === "applied" || snapshot.applied === true) return view(run);
  if (!snapshot.parsedResult?.students?.length) {
    const updated = await db.feedbackIntakeRun.update({
      where: { id },
      data: {
        status: parseJson<FeedbackIntakeIssue[]>(run.issues, []).length ? "needs_review" : "applied",
        appliedSummary: JSON.stringify({ ...snapshot, applied: true }),
      },
    });
    return view(updated);
  }
  const rawText = `统一反馈材料入口：${run.sessionCode}\n${run.sourceFingerprint}`;
  const existingDraft = await db.draftRecord.findFirst({
    where: { sessionCode: run.sessionCode, rawText, status: { in: ["pending", "confirmed"] } },
    select: { id: true, status: true },
  });
  if (!existingDraft) {
    const draft = await db.draftRecord.create({
      data: {
        rawText,
        parsedResult: JSON.stringify(snapshot.parsedResult),
        status: "pending",
        sessionCode: run.sessionCode,
        studentId: snapshot.parsedResult.students[0]?.studentId ?? null,
      },
    });
    await processDraftReview({ draftId: draft.id, action: "confirm", edits: snapshot.parsedResult }, db);
  } else if (existingDraft.status === "pending") {
    await processDraftReview({ draftId: existingDraft.id, action: "confirm", edits: snapshot.parsedResult }, db);
  }
  const updated = await db.feedbackIntakeRun.update({
    where: { id },
    data: {
      status: parseJson<FeedbackIntakeIssue[]>(run.issues, []).length ? "needs_review" : "applied",
      appliedSummary: JSON.stringify({ ...snapshot, applied: true }),
    },
  });
  return view(updated);
}

export async function resolveFeedbackIntakeRun(id: string, input: { action: "apply" | "resolve" | "create_plan"; plan?: Omit<FeedbackPlanCreateInput, "sessionId" | "semesterId" | "classId"> & { type?: FeedbackPlanCreateInput["type"] } }, db: PrismaClient = prisma) {
  const run = await db.feedbackIntakeRun.findUnique({ where: { id } });
  if (!run) throw new Error("反馈材料运行不存在");
  if (input.action === "apply") return applyFeedbackIntakeRun(id, db);
  if (input.action === "resolve") {
    await applyFeedbackIntakeRun(id, db);
    const updated = await db.feedbackIntakeRun.update({ where: { id }, data: { status: "applied", issues: "[]" } });
    return view(updated);
  }
  const session = await db.classSession.findUnique({ where: { code: run.sessionCode }, select: { id: true, semesterId: true, classId: true } });
  if (!session?.classId) throw new Error("反馈材料目标课次不存在或未关联班级");
  const snapshot = parseJson<{ assessmentEvidence?: Record<string, unknown> }>(run.appliedSummary, {});
  const confirmedLessonMaterial = await confirmedMaterialForSession(session.id, db);
  const requestedLessonMaterial = input.plan?.lessonMaterial;
  const lessonMaterial = requestedLessonMaterial && lessonMaterialHasContent(requestedLessonMaterial)
    ? requestedLessonMaterial
    : confirmedLessonMaterial ?? undefined;
  const planInput = {
    type: input.plan?.type ?? "event_micro",
    outputRequirement: input.plan?.outputRequirement ?? "为每名入选学生生成一条可复核的家长反馈",
    semesterId: session.semesterId,
    classId: session.classId,
    sessionId: session.id,
    ...(input.plan?.studentIds ? { studentIds: input.plan.studentIds } : {}),
    ...(input.plan?.generationPreferences ? { generationPreferences: input.plan.generationPreferences } : {}),
    ...(lessonMaterial ? { lessonMaterial } : {}),
    ...(Object.keys(snapshot.assessmentEvidence ?? {}).length ? { assessmentEvidence: snapshot.assessmentEvidence } : {}),
  } as FeedbackPlanCreateInput;
  const plan = await createFeedbackPlan(planInput, db);
  await db.feedbackIntakeRun.update({ where: { id }, data: { planId: plan.id, status: "applied" } });
  return { ...view((await db.feedbackIntakeRun.findUniqueOrThrow({ where: { id } }))), plan: await getFeedbackPlan(plan.id, db) };
}

export async function filesFromInbox() {
  return readInboxFiles();
}

export type FeedbackIntakeDb = PrismaClient | Prisma.TransactionClient;
