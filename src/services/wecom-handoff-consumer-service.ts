import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { WccStudentTrackFileV1 } from "@/lib/contracts/wecom-file-transfer";
import {
  formatFeedbackCommunicationSummary,
  normalizeFeedbackUseDecision,
} from "@/lib/feedback-communication";
import { feedbackDateRangeLabel } from "@/lib/feedback-time";
import { inferGroundedCommunicationPreferenceSignals } from "@/lib/communication-preference";
import { generateWeComBridgeJson } from "@/services/wecom-handoff-extraction-service";
import {
  candidateSemesterIdsForEvidence,
  handoffEvidenceDates,
} from "@/services/wecom-handoff-alignment-service";
import { summarizeMessageDateRange } from "@/services/wecom-session-matcher";
import { assertSessionAvailable } from "@/services/academic-scope-recycle-service";

function stableDraftId(batchId: string, studentId: string, messageIds: string[]) {
  const digest = createHash("sha256")
    .update([batchId, studentId, ...messageIds].join("\0"))
    .digest("hex")
    .slice(0, 28);
  return `wcc-${digest}`;
}

function sourceText(payload: WccStudentTrackFileV1) {
  return payload.messages.map((message) => (
    `[消息ID:${message.id}][${message.sentAt || "时间未知"}] ${message.sender || "未知"}: ${message.content}`
  )).join("\n");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parsedPreferenceSignals(value: string) {
  try {
    const parsed = objectValue(JSON.parse(value));
    return Array.isArray(objectValue(parsed.wccSource).preferenceSignals)
      ? objectValue(parsed.wccSource).preferenceSignals as unknown[]
      : [];
  } catch {
    return [];
  }
}

export async function consumeWccHandoffPackage(
  prisma: PrismaClient,
  payload: WccStudentTrackFileV1,
  selectedStudentId: string,
  lineage?: {
    handoffPackageId: string;
    kind: "standard" | "replacement" | "correction";
    supersedesDraftId?: string;
    communicationId?: string;
  },
) {
  const uniqueMessageIds = [...new Set(payload.messages.map((message) => message.id).filter(Boolean))];
  if (uniqueMessageIds.length !== payload.messages.length) throw new Error("duplicate_message_ids");
  const students = await prisma.student.findMany({
    where: {
      id: selectedStudentId,
      enrollments: { some: { class: { deletedAt: null }, semester: { deletedAt: null } } },
    },
    include: {
      enrollments: {
        where: { class: { deletedAt: null }, semester: { deletedAt: null } },
        include: { class: true, semester: true },
      },
    },
  });
  if (students.length !== 1) throw new Error("directory_conflict");
  const current = new Map(students.map((student) => [student.id, student]));

  // handoff 包不携带 ST 身份或课次。候选范围只使用 ST 本端唯一匹配或教师选择的学生。
  const candidateStudentIds = students.map((student) => student.id);
  const evidenceDates = handoffEvidenceDates(payload);
  const candidateSemesterIds = await candidateSemesterIdsForEvidence(prisma, evidenceDates);
  const selectedSemesterIds = [...new Set(students[0].enrollments
    .filter((enrollment) => candidateSemesterIds.includes(enrollment.semesterId))
    .map((enrollment) => enrollment.semesterId))];
  const evidenceSemesterId = selectedSemesterIds.length === 1 ? selectedSemesterIds[0] : null;
  const currentClassIds = evidenceSemesterId
    ? [...new Set(students.flatMap((student) => student.enrollments.filter((enrollment) => enrollment.semesterId === evidenceSemesterId).map((enrollment) => enrollment.classId)))]
    : [];
  const sameDaySessions = evidenceSemesterId && evidenceDates.length && currentClassIds.length
    ? await prisma.classSession.findMany({
      where: {
        semesterId: evidenceSemesterId,
        classId: { in: currentClassIds },
        date: { in: evidenceDates },
        semester: { deletedAt: null },
        class: { deletedAt: null },
      },
      select: { code: true, classId: true, date: true, semesterId: true },
      orderBy: { code: "asc" },
    })
    : [];
  const sessionsByClassDate = new Map<string, string[]>();
  for (const session of sameDaySessions) {
    const key = `${session.classId}\0${session.date}`;
    sessionsByClassDate.set(key, [...(sessionsByClassDate.get(key) ?? []), session.code]);
  }

  const generated = await generateWeComBridgeJson(prisma, {
    sourceText: sourceText(payload),
    candidateStudentIds,
    ...(evidenceSemesterId ? { semesterId: evidenceSemesterId } : {}),
    includeInactive: true,
    groundedMessages: payload.messages.map((message) => ({
      id: message.id,
      content: message.content,
      direction: message.direction,
    })),
  });
  let records = Array.isArray(objectValue(generated.bridgeJson).records)
    ? objectValue(generated.bridgeJson).records as unknown[]
    : [];
  const classificationReasons = payload.classification.reasons ?? [];
  if (
    records.length === 0
    && classificationReasons.includes("feedback_category_feedback_preference")
    && candidateStudentIds.length === 1
  ) {
    const preferenceSignals = inferGroundedCommunicationPreferenceSignals(payload.messages);
    if (preferenceSignals.length > 0) {
      const messageIds = [...new Set(preferenceSignals.map((signal) => signal.messageId))];
      records = [{
        matchedStudent: { id: candidateStudentIds[0], confidence: "high" },
        messageIds,
        factualSummary: "家长明确表达了反馈接收偏好，具体设置需教师核对原文证据。",
        feedbackUse: { relevant: true, category: "feedback-preference", priority: "medium" },
        preferenceSignals,
        evidence: preferenceSignals.slice(0, 3).map((signal) => ({
          messageId: signal.messageId,
          quote: signal.quote,
        })),
        confidence: "high",
      }];
    }
  }
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
    const evidenceMessages = payload.messages.filter((message) => messageIds.includes(message.id));
    const evidenceRange = summarizeMessageDateRange(evidenceMessages.map((message) => message.sentAt));
    const occurredAt = evidenceRange
      ? feedbackDateRangeLabel({ start: evidenceRange.min, end: evidenceRange.max })
      : "";
    const id = stableDraftId(payload.packageId, student.id, messageIds);
    const communicationSummary = formatFeedbackCommunicationSummary(
      summary,
      occurredAt,
      feedbackUse,
    );
    const evidence = Array.isArray(record.evidence) ? record.evidence : [];
    const preferenceSignals = Array.isArray(record.preferenceSignals) ? record.preferenceSignals : [];
    // 只有证据都落在同一中国日历日、学生当前班级当天恰好一节课时才自动绑定。
    // 其余情形保留为 null，由教师在候选面板明确选择，避免把正式沟通绑错课次。
    const evidenceDate = evidenceRange && evidenceRange.min === evidenceRange.max
      ? evidenceRange.min
      : null;
    const eligibleClassIds = student.enrollments
      .filter((enrollment) => Boolean(evidenceDate && evidenceSemesterId && enrollment.semesterId === evidenceSemesterId))
      .map((enrollment) => enrollment.classId);
    const exactSessionCodes = evidenceDate
      ? eligibleClassIds.flatMap((classId) => sessionsByClassDate.get(`${classId}\0${evidenceDate}`) ?? [])
      : [];
    const sessionCode = exactSessionCodes.length === 1 ? exactSessionCodes[0] : null;
    const parsedResult = {
      students: [{
        name: student.name,
        scores: { A: null, B: null, C: null },
        events: [],
        communication: {
          type: String(record.target || "家长"),
          summary: communicationSummary,
          ...(occurredAt ? { occurredAt } : {}),
        },
        attentionSignals: Array.isArray(record.attentionSignals) ? record.attentionSignals : [],
      }],
      alert_suggestion: "",
      wccSource: {
        packageId: payload.packageId,
        conversation: payload.conversation,
        messageIds,
        evidence,
        preferenceSignals,
        feedbackUse,
        classification: payload.classification,
        // 只保存此候选的证据日期范围，而不是整批会话范围。
        occurredAt: evidenceRange,
      },
    };
    const rawText = JSON.stringify({
      packageId: payload.packageId,
      conversation: payload.conversation,
      messageIds,
      evidence,
      classification: payload.classification,
    });
    const serializedParsedResult = JSON.stringify(parsedResult);
    const existingOrCreated = await prisma.draftRecord.upsert({
      where: { id },
      create: {
        id,
        rawText,
        parsedResult: serializedParsedResult,
        status: "pending",
        kind: lineage?.kind ?? "standard",
        studentId: student.id,
        sessionCode,
        supersedesDraftId: lineage?.supersedesDraftId,
        communicationId: lineage?.communicationId,
        handoffPackageId: lineage?.handoffPackageId,
      },
      // Repeated delivery cannot rewrite confirmed history. A separately
      // selected retry may enrich only the still-pending draft below.
      update: {},
    });
    const draft = existingOrCreated.status === "pending"
      && preferenceSignals.length > 0
      && parsedPreferenceSignals(existingOrCreated.parsedResult).length === 0
      ? await prisma.draftRecord.update({
        where: { id },
        data: { rawText, parsedResult: serializedParsedResult },
      })
      : existingOrCreated;
    drafts.push({ id: draft.id, status: draft.status, kind: draft.kind, studentId: student.id, studentName: student.name });
  }
  return {
    packageId: payload.packageId,
    status: drafts.length ? "pending_review" : "no_value",
    drafts,
    model: generated.diagnostics,
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
    select: { id: true, code: true, classId: true, semesterId: true },
  });
  if (!session) throw new Error("session_not_found");
  await assertSessionAvailable(session.id, prisma);
  const student = draft.studentId
    ? await prisma.student.findUnique({
        where: { id: draft.studentId },
        include: {
          enrollments: {
            where: { class: { deletedAt: null }, semester: { deletedAt: null } },
            select: { classId: true, semesterId: true },
          },
        },
      })
    : null;
  if (!student || (session.classId && !student.enrollments.some((enrollment) => enrollment.classId === session.classId && enrollment.semesterId === session.semesterId))) throw new Error("session_class_conflict");
  return prisma.draftRecord.update({ where: { id: draftId }, data: { sessionCode } });
}
