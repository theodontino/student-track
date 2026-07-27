import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  formatFeedbackCommunicationSummary,
  normalizeFeedbackUseDecision,
} from "@/lib/feedback-communication";
import { generateWeComBridgeJson } from "@/services/wecom-bridge-service";
import { buildWccDirectorySnapshot } from "@/services/wecomcatch-directory-service";
import { shanghaiCalendarDate, summarizeMessageDateRange } from "@/services/wecom-session-matcher";

interface WccMessage {
  id: string;
  sender?: string | null;
  sentAt?: string | null;
  content: string;
}

interface WccSubject {
  id: string;
  name: string;
  studentId: string;
  classId?: string | null;
}

export interface WccCandidateBatch {
  contractVersion: "wcc.student-track-candidates.v1";
  batchId: string;
  directoryVersion: string;
  source: { id: string; accountLabel?: string };
  conversation: { id: string; title: string };
  messages: WccMessage[];
  subjects: WccSubject[];
  semesterSuggestion?: string | null;
  triage?: {
    classifier?: string;
    modelName?: string;
    reasonCodes?: string[];
    feedbackUse?: unknown;
  };
}

function stableDraftId(batchId: string, studentId: string, messageIds: string[]) {
  const digest = createHash("sha256")
    .update([batchId, studentId, ...messageIds].join("\0"))
    .digest("hex")
    .slice(0, 28);
  return `wcc-${digest}`;
}

function sourceText(batch: WccCandidateBatch) {
  return batch.messages.map((message) => (
    `[消息ID:${message.id}][${message.sentAt || "时间未知"}] ${message.sender || "未知"}: ${message.content}`
  )).join("\n");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function acceptWccCandidateBatch(prisma: PrismaClient, batch: WccCandidateBatch) {
  if (batch.contractVersion !== "wcc.student-track-candidates.v1") throw new Error("unsupported_contract");
  if (!batch.batchId || !batch.conversation?.id || !Array.isArray(batch.messages) || !batch.messages.length) {
    throw new Error("invalid_batch");
  }
  const uniqueMessageIds = [...new Set(batch.messages.map((message) => message.id).filter(Boolean))];
  if (uniqueMessageIds.length !== batch.messages.length) throw new Error("duplicate_message_ids");
  const directory = await buildWccDirectorySnapshot(prisma);
  if (!batch.directoryVersion) throw new Error("invalid_batch");
  const directoryRevalidated = batch.directoryVersion !== directory.version;
  const requestedIds = [...new Set((batch.subjects || []).map((subject) => subject.id).filter(Boolean))];
  if (!requestedIds.length) throw new Error("missing_subjects");
  const students = await prisma.student.findMany({
    where: { id: { in: requestedIds } },
    select: { id: true, name: true, studentId: true, classId: true },
  });
  const current = new Map(students.map((student) => [student.id, student]));
  for (const subject of batch.subjects) {
    const student = current.get(subject.id);
    if (!student || student.name !== subject.name || student.studentId !== subject.studentId) {
      throw new Error("directory_conflict");
    }
  }

  // 花名册里的班级是快照信息，不是稳定身份；候选范围只按当前已复核的学生 ID
  // 决定。课次绑定在每条候选的证据消息校验后再做，不能借整批最早消息猜测。
  const candidateStudentIds = students.map((student) => student.id);
  const messageDateById = new Map(batch.messages.map((message) => [
    message.id,
    shanghaiCalendarDate(message.sentAt),
  ]));
  const evidenceDates = [...new Set([...messageDateById.values()].filter((value): value is string => Boolean(value)))];
  const currentClassIds = [...new Set(students.map((student) => student.classId).filter((value): value is string => Boolean(value)))];
  const sameDaySessions = evidenceDates.length && currentClassIds.length
    ? await prisma.classSession.findMany({
      where: {
        classId: { in: currentClassIds },
        date: { in: evidenceDates },
        ...(batch.semesterSuggestion ? { semesterId: batch.semesterSuggestion } : {}),
      },
      select: { code: true, classId: true, date: true },
      orderBy: { code: "asc" },
    })
    : [];
  const sessionsByClassDate = new Map<string, string[]>();
  for (const session of sameDaySessions) {
    const key = `${session.classId}\0${session.date}`;
    sessionsByClassDate.set(key, [...(sessionsByClassDate.get(key) ?? []), session.code]);
  }

  const generated = await generateWeComBridgeJson(prisma, {
    sourceText: sourceText(batch),
    candidateStudentIds,
    groundedMessages: batch.messages.map((message) => ({ id: message.id, content: message.content })),
  });
  const records = Array.isArray(objectValue(generated.bridgeJson).records)
    ? objectValue(generated.bridgeJson).records as unknown[]
    : [];
  const drafts = [];
  for (const rawRecord of records) {
    const record = objectValue(rawRecord);
    const matched = objectValue(record.matchedStudent);
    const student = current.get(String(matched.id || ""));
    if (!student) continue;
    // 二次校验：LLM 只能选择本次确定性花名册中的学生。
    if (!candidateStudentIds.includes(student.id)) continue;
    const summary = String(record.factualSummary || record.summaryForStudentTrack || record.summary || "").trim();
    if (!summary) continue;
    const feedbackUse = normalizeFeedbackUseDecision(record.feedbackUse);
    if (!feedbackUse?.relevant || feedbackUse.priority === "low") continue;
    const messageIds = Array.isArray(record.messageIds)
      ? record.messageIds.filter((value): value is string => typeof value === "string" && uniqueMessageIds.includes(value))
      : Array.isArray(objectValue(record.source).messageIds)
        ? (objectValue(record.source).messageIds as string[]).filter((value) => uniqueMessageIds.includes(value))
        : uniqueMessageIds;
    const evidenceMessages = batch.messages.filter((message) => messageIds.includes(message.id));
    const evidenceRange = summarizeMessageDateRange(evidenceMessages.map((message) => message.sentAt));
    const occurredAt = evidenceMessages
      .map((message) => message.sentAt || "")
      .sort()
      .at(-1) ?? "";
    const id = stableDraftId(batch.batchId, student.id, messageIds);
    const communicationSummary = formatFeedbackCommunicationSummary(
      summary,
      occurredAt,
      feedbackUse,
    );
    const evidence = Array.isArray(record.evidence) ? record.evidence : [];
    // 只有证据都落在同一中国日历日、学生未转班、且该班当天恰好一节课时才自动绑定。
    // 其余情形保留为 null，由教师在候选面板明确选择，避免把正式沟通绑错课次。
    const sourceSubject = batch.subjects.find((subject) => subject.id === student.id);
    const evidenceDate = evidenceRange && evidenceRange.min === evidenceRange.max
      ? evidenceRange.min
      : null;
    const canAutoBind = Boolean(evidenceDate && student.classId && sourceSubject?.classId === student.classId);
    const exactSessionCodes = canAutoBind
      ? sessionsByClassDate.get(`${student.classId}\0${evidenceDate}`) ?? []
      : [];
    const sessionCode = exactSessionCodes.length === 1 ? exactSessionCodes[0] : null;
    const parsedResult = {
      students: [{
        name: student.name,
        scores: { A: null, B: null, C: null },
        events: [],
        communication: { type: String(record.target || "家长"), summary: communicationSummary },
        attentionSignals: Array.isArray(record.attentionSignals) ? record.attentionSignals : [],
      }],
      alert_suggestion: "",
      wccSource: {
        batchId: batch.batchId,
        conversation: batch.conversation,
        messageIds,
        evidence,
        feedbackUse,
        semesterSuggestion: batch.semesterSuggestion || null,
        triage: batch.triage || null,
        // 只保存此候选的证据日期范围，而不是整批会话范围。
        occurredAt: evidenceRange,
      },
    };
    const draft = await prisma.draftRecord.upsert({
      where: { id },
      create: {
        id,
        rawText: JSON.stringify({
          batchId: batch.batchId,
          conversation: batch.conversation,
          messageIds,
          evidence,
          triage: batch.triage || null,
        }),
        parsedResult: JSON.stringify(parsedResult),
        status: "pending",
        studentId: student.id,
        sessionCode,
      },
      // 重复交付只能幂等返回，不能改写已确认草稿的历史课次。
      update: {},
    });
    drafts.push({ id: draft.id, status: draft.status, studentId: student.id, studentName: student.name });
  }
  return {
    batchId: batch.batchId,
    status: drafts.length ? "pending_review" : "no_value",
    drafts,
    model: generated.diagnostics,
    directoryRevalidated,
    receivedDirectoryVersion: batch.directoryVersion,
    currentDirectoryVersion: directory.version,
  };
}

export async function assignWccDraftSession(
  prisma: PrismaClient,
  draftId: string,
  sessionCode: string,
) {
  const draft = await prisma.draftRecord.findUnique({ where: { id: draftId } });
  if (!draft || !draft.id.startsWith("wcc-")) throw new Error("draft_not_found");
  if (draft.status !== "pending") throw new Error("draft_not_pending");
  const session = await prisma.classSession.findUnique({
    where: { code: sessionCode },
    select: { code: true, classId: true, semesterId: true },
  });
  if (!session) throw new Error("session_not_found");
  const student = draft.studentId
    ? await prisma.student.findUnique({ where: { id: draft.studentId }, select: { classId: true } })
    : null;
  if (!student || (session.classId && session.classId !== student.classId)) throw new Error("session_class_conflict");
  return prisma.draftRecord.update({ where: { id: draftId }, data: { sessionCode } });
}
