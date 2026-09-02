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
import { parseStepClassroomEnvelope, createStepObservationOnlyResult, STEP_CLASSROOM_HEADER } from "@/services/step-classroom-import-service";
import { parseAssessmentPdf } from "@/services/assessment-pdf-service";
import { processDraftReview } from "@/services/review-service";
import { createFeedbackPlan, getFeedbackPlan } from "@/services/feedback-plan-service";
import type { FeedbackPlanCreateInput } from "@/lib/feedback-plan";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";
import { isBlockingFeedbackIntakeIssue, isSourceScopedBoundaryIssue } from "@/lib/feedback-intake-rules";
import { prisma } from "@/lib/prisma";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 200;
const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const INTAKE_PARSER_VERSION = 3;

type IntakeSource = "upload" | "inbox";
export type IntakeKind = "assistant_roster" | "step_classroom" | "assessment_pdf";

export interface IntakeFile {
  name: string;
  buffer: ArrayBuffer;
  source: IntakeSource;
}

export interface ExpandedFeedbackIntakeFile extends IntakeFile {
  displayName: string;
}

export interface FeedbackIntakeIssue {
  id: string;
  code: string;
  message: string;
  sourceName?: string;
  candidates?: Array<{ id: string; name: string; studentId: string }>;
  stage?: "class" | "student" | "session" | "fact";
  rowNumber?: number;
  reportedStudent?: { name: string; studentId: string };
  rosterHint?: string;
  severity: "requires_teacher" | "error";
}

export { isBlockingFeedbackIntakeIssue } from "@/lib/feedback-intake-rules";

export type FeedbackIntakeDecisionAction =
  | "ignore_source"
  | "accept_source"
  | "bind_student"
  | "skip_student"
  | "use_assistant"
  | "use_step"
  | "skip_attendance"
  | "merge_observation"
  | "use_observation"
  | "ignore_observation"
  | "edit_observation"
  | "select_pdf";

export interface FeedbackIntakeDecision {
  issueId: string;
  action: FeedbackIntakeDecisionAction;
  studentId?: string;
  sourceName?: string;
  text?: string;
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
  sourceManifest: Array<{ name: string; source: IntakeSource; kind: IntakeKind | "ignored"; size: number; sourceHash?: string }>;
  parsedResult: DraftStructuredResult;
  assessmentEvidence: Record<string, unknown>;
  issues: FeedbackIntakeIssue[];
  summary: FeedbackIntakeSummary;
  sourceFacts?: IntakeSourceFact[];
}

interface IntakeSourceFact {
  key: string;
  kind: IntakeKind;
  sourceNames: string[];
  parsedResult?: DraftStructuredResult;
  assessmentEvidence?: Record<string, unknown>;
  issues: FeedbackIntakeIssue[];
  assistantMatch?: {
    matchedClass: boolean;
    matchedStudents: number;
    totalStudentRows: number;
    sessionStatus: "matched" | "missing" | "mismatch";
  };
  unresolvedStudents?: Array<{
    issueId: string;
    student: ParsedStudent;
    candidates: Array<{ id: string; name: string; studentId: string }>;
  }>;
  unresolvedObservations?: Array<{
    issueId: string;
    studentId: string;
    studentName: string;
    text: string;
  }>;
  unresolvedAssessments?: Array<{
    issueId: string;
    evidence: unknown;
  }>;
}

interface IntakeSnapshot {
  parsedResult?: DraftStructuredResult;
  assessmentEvidence?: Record<string, unknown>;
  sourceFacts?: IntakeSourceFact[];
  decisions?: FeedbackIntakeDecision[];
  applied?: boolean;
  scopeConfirmation?: FeedbackScopeConfirmation;
}

export interface FeedbackScopeConfirmation {
  classId: string;
  sessionCode: string;
  studentIds: string[];
  confirmedAt: string;
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

function expandZip(file: IntakeFile): ExpandedFeedbackIntakeFile[] {
  const buffer = Buffer.from(file.buffer);
  const searchStart = Math.max(0, buffer.length - 65_557);
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), buffer.length - 4);
  if (endOffset < searchStart) zipError("缺少结束目录，文件可能损坏");
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (entryCount > MAX_ZIP_ENTRIES) zipError(`条目超过 ${MAX_ZIP_ENTRIES} 个`);
  const result: ExpandedFeedbackIntakeFile[] = [];
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
  const expanded: ExpandedFeedbackIntakeFile[] = [];
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

function classify(file: ExpandedFeedbackIntakeFile): IntakeKind | "ignored" {
  const lower = file.name.toLocaleLowerCase();
  if (lower.split(/[\\/]/).pop()?.startsWith("~$")) return "ignored";
  if (lower.endsWith(".xlsx")) return "assistant_roster";
  if (lower.endsWith(".step-classroom.txt") || lower.endsWith("step-classroom.txt")) return "step_classroom";
  if (lower.endsWith(".txt")) {
    const text = new TextDecoder().decode(file.buffer.slice(0, 512));
    return text.includes(STEP_CLASSROOM_HEADER) ? "step_classroom" : "ignored";
  }
  if (lower.endsWith(".pdf")) return "assessment_pdf";
  return "ignored";
}

export function classifyFeedbackIntakeFile(name: string, buffer = new ArrayBuffer(0)): IntakeKind | "ignored" {
  return classify({ name, displayName: name, buffer, source: "upload" });
}

function issue(code: string, message: string, sourceName?: string, severity: FeedbackIntakeIssue["severity"] = "requires_teacher", candidates?: FeedbackIntakeIssue["candidates"]): FeedbackIntakeIssue {
  return {
    id: `${code}:${sourceName ?? "run"}:${sha256(message).slice(0, 10)}`,
    code,
    message,
    ...(sourceName ? { sourceName } : {}),
    ...(candidates?.length ? { candidates } : {}),
    severity,
  };
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
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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

function studentKey(student: Pick<ParsedStudent, "studentId" | "name">) {
  return student.studentId || `name:${student.name}`;
}

function addStudent(target: Map<string, ParsedStudent>, student: ParsedStudent) {
  const key = studentKey(student);
  const existing = target.get(key);
  if (!existing) { target.set(key, student); return; }
  target.set(key, {
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

function manifestFor(files: ExpandedFeedbackIntakeFile[]) {
  return files.map((file) => ({
    name: file.displayName,
    source: file.source,
    kind: classify(file),
    size: file.buffer.byteLength,
    sourceHash: sha256(new Uint8Array(file.buffer)),
  }));
}

function sourceSignature(file: { name: string; size?: number; sourceHash?: string }) {
  return `${file.name}\u0000${file.sourceHash ?? ""}\u0000${file.size ?? ""}`;
}

function lessonNumberMatches(value: string, semesterNumber: number) {
  const digits = value.match(/\d+/)?.[0];
  return Boolean(digits && Number(digits) === semesterNumber);
}

export function resolveIntakeStudentIdentity(
  roster: Array<{ id: string; name: string; studentId: string }>,
  reportedStudentId: string,
  reportedName: string,
) {
  const normalizedStudentId = reportedStudentId.trim();
  const normalizedName = reportedName.trim();
  const idMatch = normalizedStudentId ? roster.find((student) => student.studentId === normalizedStudentId) : undefined;
  const nameCandidates = normalizedName ? roster.filter((student) => student.name.trim() === normalizedName) : [];
  const nameMatch = nameCandidates.length === 1 ? nameCandidates[0] : undefined;
  if (idMatch && normalizedName) {
    if (nameMatch?.id === idMatch.id) {
      return { match: idMatch, candidates: [idMatch], conflict: false, usedNameFallback: false };
    }
    const candidates = [idMatch, ...nameCandidates.filter((candidate) => candidate.id !== idMatch.id)];
    return { match: undefined, candidates, conflict: true, usedNameFallback: false };
  }
  if (idMatch) {
    return { match: idMatch, candidates: [idMatch], conflict: false, usedNameFallback: false };
  }
  if (nameMatch) {
    return {
      match: nameMatch,
      candidates: nameCandidates,
      conflict: false,
      usedNameFallback: Boolean(normalizedStudentId),
    };
  }
  return {
    match: undefined,
    candidates: nameCandidates,
    conflict: false,
    usedNameFallback: false,
  };
}

function mergeParsedResults(
  sourceFacts: IntakeSourceFact[],
  decisions: FeedbackIntakeDecision[] = [],
) {
  const merged = new Map<string, ParsedStudent>();
  const issues = sourceFacts.flatMap((fact) => fact.issues);
  const ignoredSources = new Set(
    decisions.filter((decision) => decision.action === "ignore_source" && decision.sourceName).map((decision) => decision.sourceName),
  );
  const acceptedIssues = new Set(decisions.filter((decision) => decision.action === "accept_source").map((decision) => decision.issueId));
  const acceptedSources = new Set(
    decisions.filter((decision) => decision.action === "accept_source" && decision.sourceName).map((decision) => decision.sourceName!),
  );
  const boundStudents = new Map(
    decisions
      .filter((decision) => decision.action === "bind_student" && decision.studentId)
      .map((decision) => [decision.issueId, decision.studentId!] as const),
  );
  const observationDecisions = new Map(
    decisions
      .filter((decision) => ["use_observation", "ignore_observation", "edit_observation"].includes(decision.action))
      .map((decision) => [decision.issueId, decision] as const),
  );
  const attendanceChoices = new Map<string, FeedbackIntakeDecisionAction>();
  for (const decision of decisions) {
    if (["use_assistant", "use_step", "skip_attendance"].includes(decision.action)) {
      const issueItem = issues.find((item) => item.id === decision.issueId);
      const studentName = issueItem?.message.match(/^(.+?) 的助教表/)?.[1];
      if (studentName) attendanceChoices.set(studentName, decision.action);
    }
  }
  const evidence: Record<string, unknown> = {};
  const seenEvidence = new Set<string>();
  for (const fact of sourceFacts) {
    if (fact.sourceNames.some((name) => ignoredSources.has(name))) continue;
    const blocked = fact.issues.filter((item) => (
      ["assistant_date_missing", "assistant_date_mismatch", "assistant_lesson_missing", "assistant_lesson_mismatch", "step_date_missing", "step_date_mismatch", "assessment_date_missing", "assessment_date_mismatch"].includes(item.code)
    ));
    if (blocked.some((item) => !acceptedIssues.has(item.id) && !Boolean(item.sourceName && acceptedSources.has(item.sourceName)))) continue;
    for (const unresolved of fact.unresolvedStudents ?? []) {
      const selectedId = boundStudents.get(unresolved.issueId);
      const selected = selectedId ? unresolved.candidates.find((candidate) => candidate.id === selectedId) : undefined;
      if (!selected) continue;
      addStudent(merged, {
        ...unresolved.student,
        name: selected.name,
        studentId: selected.studentId,
      });
    }
    for (const unresolved of fact.unresolvedObservations ?? []) {
      const decision = observationDecisions.get(unresolved.issueId);
      if (!decision || decision.action === "ignore_observation") continue;
      const text = decision.action === "edit_observation" ? decision.text?.trim() : unresolved.text;
      if (!text) continue;
      addStudent(merged, {
        name: unresolved.studentName,
        studentId: unresolved.studentId,
        scores: { A: null, B: null, C: null },
        events: [text],
        communication: null,
      });
    }
    for (const student of fact.parsedResult?.students ?? []) {
      // Parser v2 completed a partial assistant sheet to the whole roster even
      // when the same sheet still had an unresolved identity row. Those
      // synthetic absences had no student number and can make an old saved run
      // impossible to confirm. They were not source facts, so omit only this
      // legacy shape while retaining every actually matched row.
      if (
        fact.kind === "assistant_roster"
        && (fact.unresolvedStudents?.length ?? 0) > 0
        && student.present === false
        && !student.studentId
      ) continue;
      const key = studentKey(student);
      const existing = merged.get(key);
      if (!existing) { merged.set(key, { ...student }); continue; }
      const presentConflict = existing.present !== undefined && student.present !== undefined && existing.present !== student.present;
      const nextScores = { ...existing.scores };
      for (const dimension of ["A", "B", "C"] as const) {
        if (existing.scores[dimension] !== null && student.scores[dimension] !== null && existing.scores[dimension] !== student.scores[dimension]) {
          issues.push(issue("score_conflict", `${existing.name} 的 ${dimension} 维度来自多个来源且结论不一致，本次不自动写入该维度`, fact.sourceNames[0]));
          nextScores[dimension] = null;
        } else if (nextScores[dimension] === null) nextScores[dimension] = student.scores[dimension];
      }
      const selectedAttendance = attendanceChoices.get(existing.name);
      const nextPresent = presentConflict
        ? selectedAttendance === "skip_attendance"
          ? undefined
          : selectedAttendance === "use_step"
            ? fact.kind === "step_classroom" ? student.present : existing.present
            : selectedAttendance === "use_assistant"
              ? fact.kind === "assistant_roster" ? student.present : existing.present
              : undefined
        : student.present ?? existing.present;
      if (presentConflict && !selectedAttendance) issues.push(issue("attendance_conflict", `${existing.name} 的助教表与 STEP 考勤结论冲突，该学生考勤暂不自动写入`, fact.sourceNames[0]));
      merged.set(key, {
        ...existing,
        scores: nextScores,
        events: [...new Set([...existing.events, ...student.events])],
        ...(nextPresent === undefined ? {} : { present: nextPresent }),
        teacherInterventions: [...new Set([...(existing.teacherInterventions ?? []), ...(student.teacherInterventions ?? [])])],
      });
    }
    for (const [studentId, value] of Object.entries(fact.assessmentEvidence ?? {})) {
      if (seenEvidence.has(studentId)) {
        const selected = decisions.find((decision) => decision.action === "select_pdf" && decision.studentId === studentId);
        if (!selected || selected.sourceName !== fact.sourceNames[0]) {
          issues.push(issue("assessment_duplicate", `学生 ${studentId} 存在多份 PDF，请选择一份`, fact.sourceNames[0]));
          continue;
        }
      }
      seenEvidence.add(studentId);
      evidence[studentId] = value;
    }
    for (const unresolved of fact.unresolvedAssessments ?? []) {
      const selectedId = boundStudents.get(unresolved.issueId);
      if (!selectedId) continue;
      if (seenEvidence.has(selectedId)) {
        issues.push(issue("assessment_duplicate", `学生 ${selectedId} 存在多份 PDF，请选择一份`, fact.sourceNames[0]));
        continue;
      }
      seenEvidence.add(selectedId);
      evidence[selectedId] = { ...(unresolved.evidence as Record<string, unknown>), studentId: selectedId };
    }
  }
  return { parsedResult: { students: [...merged.values()], alert_suggestion: "" } satisfies DraftStructuredResult, assessmentEvidence: evidence, issues };
}

async function inspectFeedbackIntakeInternal(
  input: { sessionCode: string; files: IntakeFile[]; db?: PrismaClient },
  previous?: { sourceManifest: Array<Record<string, unknown>>; snapshot: IntakeSnapshot },
): Promise<FeedbackIntakeInspection> {
  const db = input.db ?? prisma;
  const { session, roster } = await loadSession(db, input.sessionCode);
  const classInfo = session.class;
  if (!classInfo) throw new Error("课次不存在或未关联班级");
  const expansionIssues: FeedbackIntakeIssue[] = [];
  const expanded = expandFiles(input.files, expansionIssues);
  const existingManifest = previous?.sourceManifest ?? [];
  const existingSignatures = new Set(existingManifest.map((entry) => sourceSignature({ name: String(entry.name ?? ""), size: Number(entry.size ?? 0), sourceHash: typeof entry.sourceHash === "string" ? entry.sourceHash : undefined })));
  const freshExpanded = expanded.filter((file) => !existingSignatures.has(sourceSignature({ name: file.displayName, size: file.buffer.byteLength, sourceHash: sha256(new Uint8Array(file.buffer)) })));
  const freshManifest = manifestFor(freshExpanded);
  const manifest = [...existingManifest, ...freshManifest] as Array<{ name: string; source: IntakeSource; kind: IntakeKind | "ignored"; size: number; sourceHash?: string }>;
  const sourceFingerprint = sha256(JSON.stringify({
    parserVersion: INTAKE_PARSER_VERSION,
    sessionCode: input.sessionCode,
    files: manifest
      .map((file) => ({ name: file.name, size: file.size, sourceHash: file.sourceHash ?? "" }))
      .sort((left, right) => sourceSignature(left).localeCompare(sourceSignature(right))),
  }));
  const byStudentId = new Map(roster.map((student) => [student.studentId, student]));
  const sourceFacts: IntakeSourceFact[] = [...(previous?.snapshot.sourceFacts ?? [])];
  for (const file of freshExpanded.filter((item) => classify(item) === "assistant_roster")) {
    const sourceIssues: FeedbackIntakeIssue[] = [];
    const sourceName = file.displayName;
    let rows: ReturnType<typeof parseAssistantRosterFiles> = [];
    try {
      rows = parseAssistantRosterFiles([{ name: sourceName, buffer: toArrayBuffer(file.buffer) }], session.date);
    } catch (error) {
      sourceIssues.push(issue("assistant_invalid", error instanceof Error ? error.message : "助教表无法解析", sourceName, "error"));
      sourceFacts.push({ key: sourceName, kind: "assistant_roster", sourceNames: [sourceName], issues: sourceIssues });
      continue;
    }
    const targetRows = rows.filter((row) => row.classCode === classInfo.code || row.className === classInfo.name);
    if (!targetRows.length) {
      sourceIssues.push({
        ...issue("assistant_class_mismatch", `助教表中没有找到 ${classInfo.name ?? classInfo.code} 的课堂记录`, sourceName, "error"),
        stage: "class",
      });
      sourceFacts.push({
        key: sourceName,
        kind: "assistant_roster",
        sourceNames: [sourceName],
        issues: sourceIssues,
        assistantMatch: { matchedClass: false, matchedStudents: 0, totalStudentRows: 0, sessionStatus: "matched" },
      });
      continue;
    }
    const reportedIds = [...new Set(targetRows.map((row) => row.studentId).filter(Boolean))];
    const reportedNames = [...new Set(targetRows.map((row) => row.name).filter(Boolean))];
    const knownReportedStudents = await db.student.findMany({
      where: { OR: [
        ...(reportedIds.length ? [{ studentId: { in: reportedIds } }] : []),
        ...(reportedNames.length ? [{ name: { in: reportedNames } }] : []),
      ] },
      select: {
        id: true,
        name: true,
        studentId: true,
        enrollments: {
          where: { semesterId: session.semesterId },
          select: { classId: true, rosterStatus: true, class: { select: { name: true } } },
        },
      },
    });
    const rosterHintFor = (row: (typeof targetRows)[number]) => {
      const idMatch = row.studentId ? knownReportedStudents.find((student) => student.studentId === row.studentId) : undefined;
      const nameMatches = knownReportedStudents.filter((student) => student.name.trim() === row.name.trim());
      const known = idMatch ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);
      if (!known) return "学生库中没有找到该学生";
      const currentEnrollment = known.enrollments.find((enrollment) => enrollment.classId === session.classId);
      if (currentEnrollment?.rosterStatus === "INACTIVE") return "该学生在当前班花名册中已停用";
      const otherEnrollment = known.enrollments.find((enrollment) => enrollment.classId !== session.classId);
      if (otherEnrollment) return `该学生当前归属${otherEnrollment.class.name ?? "其他班级"}${otherEnrollment.rosterStatus === "INACTIVE" ? "，且花名册已停用" : ""}`;
      return "学生档案存在，但不属于当前学期的当前班花名册";
    };
    const parsed = new Map<string, ParsedStudent>();
    const unresolvedStudents: NonNullable<IntakeSourceFact["unresolvedStudents"]> = [];
    const seen = new Set<string>();
    for (const row of targetRows) {
      const identity = resolveIntakeStudentIdentity(roster, row.studentId, row.name);
      let match = identity.match;
      const candidates = identity.candidates;
      if (identity.conflict) {
        const mismatch = {
          ...issue("student_identity_conflict", `${row.fileName} 第 ${row.rowNumber} 行学号与姓名无法同时匹配当前班级学生`, sourceName, "requires_teacher", candidates),
          stage: "student" as const,
          rowNumber: row.rowNumber,
          reportedStudent: { name: row.name, studentId: row.studentId },
          rosterHint: "学号与姓名指向不同的当前班学生",
        };
        sourceIssues.push(mismatch);
        unresolvedStudents.push({
          issueId: mismatch.id,
          student: { name: row.name, studentId: row.studentId, scores: { A: row.scoreA, B: row.scoreB, C: row.scoreC }, events: row.note ? [row.note] : [], communication: null, present: true },
          candidates,
        });
        continue;
      }
      if (!match) {
        if (candidates.length !== 1) {
          const mismatch = {
            ...issue("student_mismatch", `${row.fileName} 第 ${row.rowNumber} 行无法唯一匹配当前班级学生`, sourceName, "requires_teacher", candidates),
            stage: "student" as const,
            rowNumber: row.rowNumber,
            reportedStudent: { name: row.name, studentId: row.studentId },
            rosterHint: candidates.length > 1 ? "当前班存在多名同名学生" : rosterHintFor(row),
          };
          sourceIssues.push(mismatch);
          unresolvedStudents.push({
            issueId: mismatch.id,
            student: { name: row.name, scores: { A: row.scoreA, B: row.scoreB, C: row.scoreC }, events: row.note ? [row.note] : [], communication: null, present: true },
            candidates,
          });
          continue;
        }
        match = candidates[0];
      }
      if (identity.usedNameFallback) {
        sourceIssues.push(issue("student_id_fallback", `${row.name} 的学号与当前班级不一致，已按唯一姓名匹配`, sourceName));
      }
      if (seen.has(match.id)) { sourceIssues.push(issue("duplicate_student", `${match.name} 在助教表中重复出现，已保留第一条`, sourceName)); continue; }
      seen.add(match.id);
      addStudent(parsed, { name: match.name, studentId: match.studentId, scores: { A: row.scoreA, B: row.scoreB, C: row.scoreC }, events: row.note ? [row.note] : [], communication: null, present: true });
    }
    const dates = [...new Set(targetRows.map((row) => row.date))];
    const lessonNumbers = [...new Set(targetRows.map((row) => row.lessonNumber))];
    if (dates.includes("")) sourceIssues.push({ ...issue("assistant_date_missing", "助教表缺少日期，无法自动匹配课次", sourceName), stage: "session" });
    for (const date of dates.filter(Boolean)) if (date !== session.date) sourceIssues.push({ ...issue("assistant_date_mismatch", `助教表日期 ${date} 与课次日期 ${session.date} 不一致`, sourceName), stage: "session" });
    if (lessonNumbers.includes("")) sourceIssues.push({ ...issue("assistant_lesson_missing", "助教表缺少课次，无法自动匹配当前课次", sourceName), stage: "session" });
    for (const lessonNumber of lessonNumbers.filter(Boolean)) if (!lessonNumberMatches(lessonNumber, session.semesterNumber)) sourceIssues.push({ ...issue("assistant_lesson_mismatch", `助教表课次 ${lessonNumber} 与当前第 ${session.semesterNumber} 次课不一致`, sourceName), stage: "session" });
    const sessionIssues = sourceIssues.filter((item) => item.stage === "session");
    // An identity exception means this source is not a trustworthy full-class
    // roster. Keep its valid rows, but do not infer that every omitted ACTIVE
    // student was absent. That lets a teacher skip only the bad row without
    // turning the rest of a partial exception sheet into false absences.
    const completed = parsed.size
      ? unresolvedStudents.length
        ? { students: [...parsed.values()], alert_suggestion: "" }
        : completeClassAttendance({ students: [...parsed.values()], alert_suggestion: "" }, roster)
      : undefined;
    sourceFacts.push({
      key: sourceName,
      kind: "assistant_roster",
      sourceNames: [sourceName],
      parsedResult: completed,
      issues: sourceIssues,
      unresolvedStudents,
      assistantMatch: {
        matchedClass: true,
        matchedStudents: seen.size,
        totalStudentRows: targetRows.length,
        sessionStatus: sessionIssues.some((item) => item.code.endsWith("_mismatch")) ? "mismatch" : sessionIssues.length ? "missing" : "matched",
      },
    });
  }

  for (const file of freshExpanded.filter((item) => classify(item) === "step_classroom")) {
    const sourceIssues: FeedbackIntakeIssue[] = [];
    try {
      const envelope = parseStepClassroomEnvelope(Buffer.from(file.buffer).toString("utf8"));
      if (envelope.payload.class.code !== classInfo.code) {
        sourceIssues.push(issue("step_class_mismatch", `STEP 班级 ${envelope.payload.class.code} 与当前课次班级不一致`, file.displayName, "error"));
        sourceFacts.push({ key: file.displayName, kind: "step_classroom", sourceNames: [file.displayName], issues: sourceIssues });
        continue;
      }
      const completedAt = envelope.payload.completedAt;
      if (!completedAt) {
        sourceIssues.push(issue("step_date_missing", "STEP 缺少完成日期，无法自动匹配课次", file.displayName));
      } else if (completedAt.slice(0, 10) !== session.date) {
        sourceIssues.push(issue("step_date_mismatch", `STEP 完成日期 ${completedAt.slice(0, 10)} 与课次日期 ${session.date} 不一致`, file.displayName));
      }
      const stepResult = createStepObservationOnlyResult(envelope.payload);
      const parsed = new Map<string, ParsedStudent>();
      const unresolvedObservations: NonNullable<IntakeSourceFact["unresolvedObservations"]> = [];
      for (const student of stepResult.students) {
        const match = byStudentId.get(student.studentId ?? "");
        if (!match || match.name !== student.name) { sourceIssues.push(issue("step_student_mismatch", `STEP 学号 ${student.studentId ?? ""} 与当前花名册不一致`, file.displayName, "error")); continue; }
        const sourceStudent = envelope.payload.students.find((item) => item.studentId === student.studentId);
        const notes = envelope.payload.students.find((item) => item.studentId === student.studentId)?.notes ?? [];
        for (const note of notes) {
          const noteIssue = issue("step_note_review", `${match.name} · ${note.contextLabel}：${note.text}`, file.displayName);
          sourceIssues.push(noteIssue);
          unresolvedObservations.push({ issueId: noteIssue.id, studentId: match.studentId, studentName: match.name, text: note.text });
        }
        const interventions = (student.teacherInterventions ?? []).filter((item) => !item.observedProblem.includes("备注："));
        addStudent(parsed, { name: match.name, studentId: match.studentId, scores: { A: null, B: null, C: null }, events: [], communication: null, ...(sourceStudent ? { present: sourceStudent.present } : {}), teacherInterventions: interventions });
      }
      sourceFacts.push({ key: file.displayName, kind: "step_classroom", sourceNames: [file.displayName], parsedResult: { students: [...parsed.values()], alert_suggestion: "" }, issues: sourceIssues, unresolvedObservations });
    } catch (error) {
      sourceIssues.push(issue("step_invalid", error instanceof Error ? error.message : "STEP 文件无法解析", file.displayName, "error"));
      sourceFacts.push({ key: file.displayName, kind: "step_classroom", sourceNames: [file.displayName], issues: sourceIssues });
    }
  }

  for (const file of freshExpanded.filter((item) => classify(item) === "assessment_pdf")) {
    const sourceIssues: FeedbackIntakeIssue[] = [];
    const sourceEvidence: Record<string, unknown> = {};
    const unresolvedAssessments: NonNullable<IntakeSourceFact["unresolvedAssessments"]> = [];
    try {
      const parsed = await parseAssessmentPdf(toArrayBuffer(file.buffer), file.displayName);
      const identity = resolveIntakeStudentIdentity(roster, parsed.reportStudentId, parsed.reportStudentName);
      let identityMatch = identity.match;
      if (parsed.reportStudentId && !identityMatch && !identity.conflict) {
        const matchIssue = issue("assessment_student_mismatch", "PDF 学号不属于当前班级，请绑定当前班学生或忽略", file.displayName, "requires_teacher", roster);
        sourceIssues.push(matchIssue);
        unresolvedAssessments.push({ issueId: matchIssue.id, evidence: { ...parsed.evidence, sourceType: "assessment_pdf", sessionCode: input.sessionCode } });
        identityMatch = undefined;
      } else if (identity.conflict) {
        const matchIssue = issue("assessment_identity_conflict", "PDF 内姓名和学号对应不同学生，请重新绑定或忽略", file.displayName, "requires_teacher", roster);
        sourceIssues.push(matchIssue);
        unresolvedAssessments.push({ issueId: matchIssue.id, evidence: { ...parsed.evidence, sourceType: "assessment_pdf", sessionCode: input.sessionCode } });
        identityMatch = undefined;
      } else if (!parsed.reportStudentId && !identityMatch) {
        const matchIssue = issue("assessment_needs_match", "PDF 未能唯一匹配当前班级学生", file.displayName, "requires_teacher", roster);
        sourceIssues.push(matchIssue);
        unresolvedAssessments.push({ issueId: matchIssue.id, evidence: { ...parsed.evidence, sourceType: "assessment_pdf", sessionCode: input.sessionCode } });
        identityMatch = undefined;
      }
      if (identity.usedNameFallback && identityMatch) {
        sourceIssues.push(issue("assessment_student_id_fallback", "PDF 学号与当前班级不一致，已按唯一姓名匹配", file.displayName));
      }
      if (!parsed.evidence.reportDate) {
        sourceIssues.push(issue("assessment_date_missing", "PDF 缺少报告日期，无法自动匹配课次", file.displayName));
      } else if (parsed.evidence.reportDate !== session.date) {
        sourceIssues.push(issue("assessment_date_mismatch", `PDF 报告日期 ${parsed.evidence.reportDate} 与课次日期 ${session.date} 不一致`, file.displayName));
      }
      if (identityMatch) sourceEvidence[identityMatch.id] = { ...parsed.evidence, sourceType: "assessment_pdf", sessionCode: input.sessionCode, studentId: identityMatch.id };
    } catch (error) {
      sourceIssues.push(issue("assessment_invalid", error instanceof Error ? error.message : "PDF 无法解析", file.displayName));
    }
    sourceFacts.push({ key: file.displayName, kind: "assessment_pdf", sourceNames: [file.displayName], assessmentEvidence: sourceEvidence, issues: sourceIssues, unresolvedAssessments });
  }

  const decisions = previous?.snapshot.decisions ?? [];
  const merged = mergeParsedResults(sourceFacts, decisions);
  const issues = [...expansionIssues, ...merged.issues];
  const assessmentEvidence = merged.assessmentEvidence;
  const allManifest = manifest as Array<{ name: string; source: IntakeSource; kind: IntakeKind | "ignored"; size: number; sourceHash?: string }>;
  const recognized = allManifest.filter((entry) => entry.kind !== "ignored").length;
  const result = { students: merged.parsedResult.students.map(normalizeDraftStudent), alert_suggestion: "" } satisfies DraftStructuredResult;
  return {
    sessionCode: input.sessionCode,
    sourceFingerprint,
    sourceManifest: allManifest,
    parsedResult: result,
    assessmentEvidence,
    issues,
    summary: {
      sourceCount: allManifest.length,
      recognizedCount: recognized,
      ignoredCount: allManifest.length - recognized,
      assistantFileCount: allManifest.filter((entry) => entry.kind === "assistant_roster").length,
      stepFileCount: allManifest.filter((entry) => entry.kind === "step_classroom").length,
      assessmentFileCount: allManifest.filter((entry) => entry.kind === "assessment_pdf").length,
      appliedStudentCount: result.students.length,
      assessmentStudentCount: Object.keys(assessmentEvidence).length,
      issueCount: issues.length,
    },
    sourceFacts,
  };
}

export async function inspectFeedbackIntake(input: { sessionCode: string; files: IntakeFile[]; db?: PrismaClient }): Promise<FeedbackIntakeInspection> {
  return inspectFeedbackIntakeInternal(input);
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function isPrismaClientDb(db: FeedbackIntakeDb): db is PrismaClient {
  return "$connect" in db && "$disconnect" in db;
}

type CommonMaterialSelection =
  | { mode: "linked_revision"; revisionId: string }
  | { mode: "session_snapshot" }
  | { mode: "none" };

async function confirmedMaterialForSession(
  sessionId: string,
  db: FeedbackIntakeDb,
  selection?: CommonMaterialSelection,
  legacyRevisionId?: string,
) {
  const link = await db.groupLessonSession.findUnique({
    where: { sessionId },
    include: { groupLesson: { include: { revisions: { orderBy: { revision: "desc" }, take: 1 } } } },
  });
  const revisionId = selection?.mode === "linked_revision" ? selection.revisionId : legacyRevisionId;
  const selectedRevision = revisionId
    ? await db.groupLessonRevision.findUnique({ where: { id: revisionId }, select: { id: true, groupLessonId: true, materialSnapshot: true } })
    : null;
  if (selection?.mode === "linked_revision" && (!selectedRevision || !link || selectedRevision.groupLessonId !== link.groupLessonId)) {
    throw new Error("共同课修订未确认或未关联当前课次");
  }
  if (selection?.mode === "none") return null;
  if (selection?.mode === "session_snapshot") {
    if (link) throw new Error("当前课次已关联共同课，请选择当前共同课修订或明确不使用");
    const session = await db.classSession.findUnique({ where: { id: sessionId }, select: { commonMaterialSnapshot: true } });
    const parsedSession = session?.commonMaterialSnapshot ? parseJson(session.commonMaterialSnapshot, null) : null;
    const sessionMaterial = LessonFeedbackMaterialSchema.safeParse(parsedSession);
    return sessionMaterial.success ? sessionMaterial.data : null;
  }
  const raw = selectedRevision?.materialSnapshot ?? link?.groupLesson.revisions[0]?.materialSnapshot;
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

async function viewWithLivePlan(
  run: Parameters<typeof view>[0],
  db: FeedbackIntakeDb,
): Promise<FeedbackIntakeRunView> {
  if (!run.planId) return view(run);
  const livePlan = await db.feedbackPlan.findFirst({
    where: { id: run.planId, archivedAt: null },
    select: { id: true },
  });
  return view(livePlan ? run : { ...run, planId: null });
}

export async function getFeedbackIntakeRun(id: string, db: PrismaClient = prisma) {
  const run = await db.feedbackIntakeRun.findUnique({ where: { id } });
  return run ? viewWithLivePlan(run, db) : null;
}

export async function createOrGetFeedbackIntakeRun(input: { sessionCode: string; files: IntakeFile[]; runId?: string; db?: PrismaClient }) {
  const db = input.db ?? prisma;
  const storedPreviousRun = input.runId ? await db.feedbackIntakeRun.findUnique({ where: { id: input.runId } }) : null;
  const previousRun = storedPreviousRun
    ? { ...storedPreviousRun, planId: (await viewWithLivePlan(storedPreviousRun, db)).planId }
    : null;
  if (input.runId && !previousRun) throw new Error("反馈材料运行不存在");
  if (previousRun && previousRun.sessionCode !== input.sessionCode) throw new Error("不能把材料追加到另一课次");
  if (previousRun?.planId) throw new Error("这轮材料已经关联 FeedbackPlan，请重新开始一轮材料");
  const previousSnapshot = previousRun ? parseJson<IntakeSnapshot>(previousRun.appliedSummary, {}) : undefined;
  const inspection = await inspectFeedbackIntakeInternal(input, previousRun ? { sourceManifest: parseJson(previousRun.sourceManifest, []), snapshot: previousSnapshot ?? {} } : undefined);
  if (previousRun) {
    // Inbox scans can present the same files again. If no source changed, keep
    // the teacher's confirmation, decisions and saved scope exactly as-is.
    if (inspection.sourceFingerprint === previousRun.sourceFingerprint) {
      return { run: await viewWithLivePlan(previousRun, db), inspection, duplicate: true };
    }
    // A browser can restore an older empty/partial run while another tab (or a
    // previous scan) has already persisted the same complete source batch. The
    // fingerprint is intentionally unique, so reuse that canonical run instead
    // of updating into a unique-constraint error.
    const canonical = await db.feedbackIntakeRun.findFirst({
      where: { sourceFingerprint: inspection.sourceFingerprint, id: { not: previousRun.id } },
      orderBy: { updatedAt: "desc" },
    });
    if (canonical) return { run: await viewWithLivePlan(canonical, db), inspection, duplicate: true };
    try {
      const updated = await db.feedbackIntakeRun.update({
        where: { id: previousRun.id },
        data: {
          sourceFingerprint: inspection.sourceFingerprint,
          sourceManifest: JSON.stringify(inspection.sourceManifest),
          status: inspection.issues.length ? "needs_review" : "ready",
          issues: JSON.stringify(inspection.issues),
          appliedSummary: JSON.stringify({ ...inspection.summary, parsedResult: inspection.parsedResult, assessmentEvidence: inspection.assessmentEvidence, sourceFacts: inspection.sourceFacts, decisions: [], applied: false }),
        },
      });
      return { run: await viewWithLivePlan(updated, db), inspection, duplicate: false };
    } catch (error) {
      const isFingerprintConflict = error instanceof Error
        && error.message.includes("Unique constraint failed on the fields: (`sourceFingerprint`)");
      if (isFingerprintConflict) {
        const canonical = await db.feedbackIntakeRun.findUnique({ where: { sourceFingerprint: inspection.sourceFingerprint } });
        if (canonical) return { run: await viewWithLivePlan(canonical, db), inspection, duplicate: true };
      }
      throw error;
    }
  }
  const existing = await db.feedbackIntakeRun.findUnique({ where: { sourceFingerprint: inspection.sourceFingerprint } });
  if (existing) return { run: await viewWithLivePlan(existing, db), inspection, duplicate: true };
  try {
    const run = await db.feedbackIntakeRun.create({
      data: {
        sessionCode: input.sessionCode,
        sourceFingerprint: inspection.sourceFingerprint,
        sourceManifest: JSON.stringify(inspection.sourceManifest),
        status: inspection.issues.length ? "needs_review" : "ready",
        issues: JSON.stringify(inspection.issues),
        appliedSummary: JSON.stringify({ ...inspection.summary, parsedResult: inspection.parsedResult, assessmentEvidence: inspection.assessmentEvidence, sourceFacts: inspection.sourceFacts, decisions: [], applied: false }),
      },
    });
    return { run: await viewWithLivePlan(run, db), inspection, duplicate: false };
  } catch (error) {
    // Two scans may pass the read-before-create check concurrently. Treat a
    // Prisma unique conflict as the same idempotent duplicate case.
    const isFingerprintConflict = error instanceof Error
      && error.message.includes("Unique constraint failed on the fields: (`sourceFingerprint`)");
    if (isFingerprintConflict) {
      const canonical = await db.feedbackIntakeRun.findUnique({ where: { sourceFingerprint: inspection.sourceFingerprint } });
      if (canonical) return { run: await viewWithLivePlan(canonical, db), inspection, duplicate: true };
    }
    throw error;
  }
}

/**
 * Starts or resumes intake without adding another file source. Existing
 * SessionMetric, Attendance and Event rows remain the source of truth for the
 * feedback context; confirming this run only records that there are no new
 * material facts to apply.
 */
export async function prepareFeedbackIntakeFromExistingFacts(input: {
  sessionCode: string;
  runId?: string;
  db?: PrismaClient;
}) {
  return createOrGetFeedbackIntakeRun({ ...input, files: [] });
}

export async function applyFeedbackIntakeRun(id: string, db: FeedbackIntakeDb = prisma, decisions: FeedbackIntakeDecision[] = []) {
  const execute = async (tx: FeedbackIntakeDb) => {
    const run = await tx.feedbackIntakeRun.findUnique({ where: { id } });
  if (!run) throw new Error("反馈材料运行不存在");
  const snapshot = parseJson<IntakeSnapshot>(run.appliedSummary, {});
  const allDecisions = [...(snapshot.decisions ?? []).filter((old) => !decisions.some((next) => next.issueId === old.issueId)), ...decisions];
  if (run.status === "applied" || snapshot.applied === true) return view(run);
  const runIssues = parseJson<FeedbackIntakeIssue[]>(run.issues, []);
  const resolvedIssueIds = new Set(allDecisions.map((decision) => decision.issueId));
  const ignoredSources = new Set(allDecisions.filter((decision) => decision.action === "ignore_source" && decision.sourceName).map((decision) => decision.sourceName!));
  const acceptedSources = new Set(allDecisions.filter((decision) => decision.action === "accept_source" && decision.sourceName).map((decision) => decision.sourceName!));
  const resolvedBySource = (item: FeedbackIntakeIssue) => Boolean(item.sourceName && (
    ignoredSources.has(item.sourceName)
    || (acceptedSources.has(item.sourceName) && isSourceScopedBoundaryIssue(item))
  ));
  const unresolved = runIssues.filter((item) => (
    isBlockingFeedbackIntakeIssue(item)
    && !resolvedIssueIds.has(item.id)
    && !resolvedBySource(item)
  ));
  if (unresolved.length) throw new Error(`还有 ${unresolved.length} 项材料异常未处理，请先完成事实确认`);
  const merged = snapshot.sourceFacts?.length
    ? mergeParsedResults(snapshot.sourceFacts, allDecisions)
    : { parsedResult: snapshot.parsedResult ?? { students: [], alert_suggestion: "" }, assessmentEvidence: snapshot.assessmentEvidence ?? {}, issues: [] };
  const generatedUnresolved = merged.issues.filter((item) => (
    isBlockingFeedbackIntakeIssue(item)
    && !resolvedIssueIds.has(item.id)
    && !resolvedBySource(item)
  ));
  if (generatedUnresolved.length) throw new Error(`材料合并后仍有 ${generatedUnresolved.length} 项冲突未处理，请返回事实确认`);
  const effectiveSnapshot = { ...snapshot, parsedResult: merged.parsedResult, assessmentEvidence: merged.assessmentEvidence, decisions: allDecisions };
  const appliedSummary = {
    ...effectiveSnapshot,
    appliedStudentCount: effectiveSnapshot.parsedResult?.students?.length ?? 0,
    assessmentStudentCount: Object.keys(effectiveSnapshot.assessmentEvidence ?? {}).length,
    applied: true,
  };
  const retainedIssues = [...runIssues, ...merged.issues]
    .filter((item) => !isBlockingFeedbackIntakeIssue(item))
    .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index);
  if (!effectiveSnapshot.parsedResult?.students?.length) {
    const updated = await tx.feedbackIntakeRun.update({
      where: { id },
      data: {
        status: "applied",
        issues: JSON.stringify(retainedIssues),
        appliedSummary: JSON.stringify(appliedSummary),
      },
    });
    return view(updated);
  }
  const rawText = JSON.stringify({
    stepSessionId: `feedback-intake:${run.id}`,
    class: { code: run.sessionCode, name: "统一课后材料" },
    students: effectiveSnapshot.parsedResult.students,
  });
  const existingDraft = await tx.draftRecord.findFirst({
    where: { sessionCode: run.sessionCode, rawText, status: { in: ["pending", "confirmed"] } },
    select: { id: true, status: true },
  });
  if (!existingDraft) {
    const draft = await tx.draftRecord.create({
      data: {
        rawText,
        parsedResult: JSON.stringify(effectiveSnapshot.parsedResult),
        status: "pending",
        sessionCode: run.sessionCode,
        studentId: effectiveSnapshot.parsedResult.students[0]?.studentId ?? null,
      },
    });
    await processDraftReview({ draftId: draft.id, action: "confirm", edits: effectiveSnapshot.parsedResult }, tx);
  } else if (existingDraft.status === "pending") {
    await processDraftReview({ draftId: existingDraft.id, action: "confirm", edits: effectiveSnapshot.parsedResult }, tx);
  }
  const updated = await tx.feedbackIntakeRun.update({
    where: { id },
    data: {
      status: "applied",
      issues: JSON.stringify(retainedIssues),
      appliedSummary: JSON.stringify(appliedSummary),
    },
  });
  return view(updated);
  };
  return isPrismaClientDb(db) ? db.$transaction((tx) => execute(tx)) : execute(db);
}

export async function confirmFeedbackIntakeScope(
  id: string,
  input: { classId: string; sessionCode: string; studentIds: string[] },
  db: FeedbackIntakeDb = prisma,
) {
  const execute = async (tx: FeedbackIntakeDb) => {
    const run = await tx.feedbackIntakeRun.findUnique({ where: { id } });
    if (!run) throw new Error("反馈材料运行不存在");
    if (run.status !== "applied") throw new Error("请先确认本班材料与事实");
    if (run.sessionCode !== input.sessionCode) throw new Error("材料运行与当前课次不一致");
    const session = await tx.classSession.findUnique({
      where: { code: input.sessionCode },
      select: { classId: true, semesterId: true },
    });
    if (!session?.classId || session.classId !== input.classId) throw new Error("当前班级与课次不一致");
    const studentIds = [...new Set(input.studentIds.map((studentId) => studentId.trim()).filter(Boolean))];
    if (!studentIds.length) throw new Error("至少选择一名反馈对象");
    const roster = await tx.student.findMany({
      where: {
        id: { in: studentIds },
        enrollments: { some: { semesterId: session.semesterId, classId: session.classId, rosterStatus: "ACTIVE" } },
      },
      select: { id: true },
    });
    if (roster.length !== studentIds.length) throw new Error("反馈对象必须属于当前班级的 ACTIVE 花名册");
    const snapshot = parseJson<IntakeSnapshot>(run.appliedSummary, {});
    const scopeConfirmation: FeedbackScopeConfirmation = {
      classId: session.classId,
      sessionCode: input.sessionCode,
      studentIds,
      confirmedAt: new Date().toISOString(),
    };
    const updated = await tx.feedbackIntakeRun.update({
      where: { id },
      data: { appliedSummary: JSON.stringify({ ...snapshot, scopeConfirmation }) },
    });
    return view(updated);
  };
  return isPrismaClientDb(db) ? db.$transaction((tx) => execute(tx)) : execute(db);
}

export async function clearFeedbackIntakeScope(id: string, db: FeedbackIntakeDb = prisma) {
  const run = await db.feedbackIntakeRun.findUnique({ where: { id } });
  if (!run) throw new Error("反馈材料运行不存在");
  const snapshot = parseJson<IntakeSnapshot>(run.appliedSummary, {});
  const next = { ...snapshot };
  delete next.scopeConfirmation;
  const updated = await db.feedbackIntakeRun.update({
    where: { id },
    data: { appliedSummary: JSON.stringify(next) },
  });
  return view(updated);
}

export async function resolveFeedbackIntakeRun(id: string, input: { action: "apply" | "confirm" | "resolve" | "create_plan" | "confirm_scope" | "clear_scope"; decisions?: FeedbackIntakeDecision[]; scope?: { classId: string; sessionCode: string; studentIds: string[] }; plan?: Omit<FeedbackPlanCreateInput, "sessionId" | "semesterId" | "classId"> & { type?: FeedbackPlanCreateInput["type"]; commonLessonRevisionId?: string; commonMaterial?: CommonMaterialSelection } }, db: FeedbackIntakeDb = prisma) {
  const run = await db.feedbackIntakeRun.findUnique({ where: { id } });
  if (!run) throw new Error("反馈材料运行不存在");
  if (input.action === "confirm_scope") {
    if (!input.scope) throw new Error("缺少班级范围确认信息");
    return confirmFeedbackIntakeScope(id, input.scope, db);
  }
  if (input.action === "clear_scope") return clearFeedbackIntakeScope(id, db);
  if (input.action === "apply" || input.action === "confirm" || input.action === "resolve") return applyFeedbackIntakeRun(id, db, input.decisions ?? []);
  if (run.status !== "applied") throw new Error("请先完成事实确认，再创建 FeedbackPlan");
  if (run.planId) {
    const existingPlan = await getFeedbackPlan(run.planId, db);
    if (existingPlan && !existingPlan.archivedAt) return { ...view(run), plan: existingPlan };
  }
  const session = await db.classSession.findUnique({ where: { code: run.sessionCode }, select: { id: true, semesterId: true, classId: true } });
  if (!session?.classId) throw new Error("反馈材料目标课次不存在或未关联班级");
  const snapshot = parseJson<IntakeSnapshot>(run.appliedSummary, {});
  const confirmedLessonMaterial = await confirmedMaterialForSession(session.id, db, input.plan?.commonMaterial, input.plan?.commonLessonRevisionId);
  const planInput = {
    type: input.plan?.type ?? "event_micro",
    outputRequirement: input.plan?.outputRequirement ?? "为每名入选学生生成一条可复核的家长反馈",
    semesterId: session.semesterId,
    classId: session.classId,
    sessionId: session.id,
    ...(input.plan?.studentIds ? { studentIds: input.plan.studentIds } : {}),
    ...(input.plan?.studentOverrides ? { studentOverrides: input.plan.studentOverrides } : {}),
    ...(input.plan?.generationPreferences ? { generationPreferences: input.plan.generationPreferences } : {}),
    ...(confirmedLessonMaterial ? { lessonMaterial: confirmedLessonMaterial } : {}),
    ...(Object.keys(snapshot.assessmentEvidence ?? {}).length ? { assessmentEvidence: snapshot.assessmentEvidence } : {}),
  } as FeedbackPlanCreateInput;
  const createPlanInTransaction = async (tx: FeedbackIntakeDb) => {
    const current = await tx.feedbackIntakeRun.findUniqueOrThrow({ where: { id } });
    if (current.planId) {
      const currentPlan = await tx.feedbackPlan.findUnique({ where: { id: current.planId }, select: { id: true, archivedAt: true } });
      if (currentPlan && !currentPlan.archivedAt) return { planId: current.planId };
      await tx.feedbackIntakeRun.update({ where: { id }, data: { planId: null } });
    }
    const plan = await createFeedbackPlan(planInput, tx);
    await tx.feedbackIntakeRun.update({ where: { id }, data: { planId: plan.id, status: "applied" } });
    return { planId: plan.id };
  };
  const result = isPrismaClientDb(db)
    ? await db.$transaction((tx) => createPlanInTransaction(tx))
    : await createPlanInTransaction(db);
  const updated = await db.feedbackIntakeRun.findUniqueOrThrow({ where: { id } });
  return { ...view(updated), plan: await getFeedbackPlan(result.planId, db) };
}

export async function filesFromInbox() {
  return readInboxFiles();
}

export type FeedbackIntakeDb = PrismaClient | Prisma.TransactionClient;
