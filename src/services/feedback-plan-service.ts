import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-errors";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CommunicationPreferenceSchema,
  FeedbackAuditSnapshotSchema,
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  FeedbackPlanCreateSchema,
  FeedbackPlanItemPatchSchema,
  isHardFeedbackAuditIssue,
  type CommunicationPreference,
  type FeedbackEvidenceBundle,
  type FeedbackPlanAssessmentEvidenceInput,
  type FeedbackPlanCreateInput,
  type FeedbackPlanItemPatch,
} from "@/lib/feedback-plan";
import type { StudentAssessmentEvidence } from "@/lib/feedback-materials";
import { createAuditSnapshot, sha256 } from "@/services/feedback-plan-audit";
import { buildFeedbackContext, type FeedbackContextStudent } from "@/services/feedback-context-service";
import { generateFeedbackPlanComposition } from "@/services/feedback-generation-service";
import { recordSuccessfulGeneration } from "@/services/generation-memory-service";
import { semesterStudentWhere } from "@/services/student-enrollment-service";

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function json(value: unknown) {
  return JSON.stringify(value);
}

function normalizedCoverageText(value: string) {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}

type FeedbackPlanDb = PrismaClient | Prisma.TransactionClient;
type NormalizedPlanAssessmentEvidence = Record<string, StudentAssessmentEvidence[]>;

function normalizePlanAssessmentEvidence(input: {
  assessmentEvidence?: FeedbackPlanAssessmentEvidenceInput;
  sessionCode: string;
  allowedStudentIds: string[];
}): NormalizedPlanAssessmentEvidence {
  const allowedStudentIds = new Set(input.allowedStudentIds);
  const normalized: NormalizedPlanAssessmentEvidence = {};
  for (const [studentId, value] of Object.entries(input.assessmentEvidence ?? {})) {
    if (!allowedStudentIds.has(studentId)) {
      throw new ApiError(`学生 ${studentId} 的测评证据不属于本次反馈对象`, 400, "invalid_request", false);
    }
    const evidenceItems = Array.isArray(value) ? value : [value];
    normalized[studentId] = evidenceItems.map((evidence) => {
      if (evidence.sessionCode && evidence.sessionCode !== input.sessionCode) {
        throw new ApiError(`学生 ${studentId} 的测评证据属于课次 ${evidence.sessionCode}`, 400, "invalid_request", false);
      }
      if (evidence.studentId && evidence.studentId !== studentId) {
        throw new ApiError(`测评证据绑定学生与提交学生 ${studentId} 不一致`, 400, "invalid_request", false);
      }
      return {
        ...evidence,
        sourceType: evidence.sourceType ?? "assessment_pdf",
        sessionCode: input.sessionCode,
        studentId,
      };
    });
  }
  return normalized;
}

function assessmentEvidenceItems(items: StudentAssessmentEvidence[]): FeedbackEvidenceBundle["assessmentEvidence"] {
  return items.map((evidence) => {
    const sourceType = evidence.sourceType ?? "assessment_pdf";
    const sourceLabel = sourceType === "classroom_practice" ? "课堂练习" : "出门测 PDF";
    const evidenceHash = sha256(JSON.stringify(evidence)).slice(0, 16);
    const knowledgePoints = evidence.knowledgePoints.slice(0, 20).map((item) => (
      `${item.name}：${item.questionCount}题，正确率${item.correctRate}%${item.cohortAverageRate === null ? "" : `，同期均值${item.cohortAverageRate}%`}`
    ));
    const wrongItems = evidence.wrongItems.slice(0, 20).map((item) => (
      `第${item.questionNumber}题本人答${item.studentAnswer || "未提取"}，正确答案${item.correctAnswer || "未提取"}${item.knowledgePoints.length ? `，涉及${item.knowledgePoints.join("、")}` : ""}`
    ));
    const content = [
      `${evidence.reportDate || "日期未知"} ${evidence.reportTitle || sourceLabel}：共${evidence.totalQuestions}题，正确率${evidence.correctRate}%${evidence.cohortAverageRate === null ? "" : `，同期均值${evidence.cohortAverageRate}%`}`,
      knowledgePoints.length ? `知识点结果：${knowledgePoints.join("；")}` : "",
      wrongItems.length ? `错题明细：${wrongItems.join("；")}` : "报告未列出错题",
      evidence.similarPracticeCount > 0 ? `报告附带${evidence.similarPracticeCount}道相似练习` : "",
      "证据边界：只能解释本次结果，不据此推断长期能力或人格特征",
    ].filter(Boolean).join("。").slice(0, 3000);
    return {
      id: `assessment-${sourceType}-${evidenceHash}`,
      kind: "fact" as const,
      content,
      sourceRefs: [{
        type: sourceType === "classroom_practice" ? "classroom-practice" : "assessment-pdf",
        id: `${sourceType}:${evidenceHash}`,
        label: sourceLabel,
      }],
      occurredAt: evidence.reportDate ? evidence.reportDate.slice(0, 64) : undefined,
      confirmed: true,
    };
  });
}

function persistedAssessmentEvidence(snapshot: string): FeedbackEvidenceBundle["assessmentEvidence"] {
  const parsed = FeedbackEvidenceBundleSchema.safeParse(parseJson(snapshot, null));
  return parsed.success ? parsed.data.assessmentEvidence : [];
}

function derivePlanStatus(items: Array<{ status: string }>) {
  if (!items.length) return "draft";
  if (items.some((item) => item.status === "stale")) return "stale";
  if (items.some((item) => item.status === "generating")) return "generating";
  if (items.every((item) => item.status === "exported")) return "exported";
  if (items.some((item) => item.status === "exported")) return "partially_exported";
  if (items.every((item) => item.status === "approved")) return "approved";
  if (items.some((item) => item.status === "approved")) return "partially_approved";
  if (items.some((item) => item.status === "needs_review")) return "in_review";
  return "draft";
}

function activeTaskIds(tasks: Array<{ id: string; status: string }>) {
  return new Set(tasks.filter((task) => task.status !== "cancelled").map((task) => task.id));
}

function parseCompositionSnapshot(value: string | null | undefined, planType: string, draftFeedback = "") {
  const parsed = FeedbackCompositionPlanSchema.safeParse(parseJson(value, null));
  if (parsed.success) return parsed.data;
  return FeedbackCompositionPlanSchema.parse({
    version: 1,
    closureType: planType === "class_update" ? "informational" : "positive_recognition",
    needParentAction: false,
    parentAction: null,
    modules: [],
    draftFeedback,
  });
}

/**
 * Routes return both the legacy snapshot columns and parsed, version-checked
 * views. Keeping the raw columns makes old history readers compatible while
 * preventing new React code from knowing that the database stores JSON text.
 */
export function toFeedbackPlanItemView<T extends {
  evidenceSnapshot: string;
  compositionSnapshot: string;
  auditSnapshot: string;
  finalText?: string | null;
}>(item: T, planType: string) {
  const evidence = FeedbackEvidenceBundleSchema.safeParse(parseJson(item.evidenceSnapshot, null));
  const composition = FeedbackCompositionPlanSchema.safeParse(parseJson(item.compositionSnapshot, null));
  const audit = FeedbackAuditSnapshotSchema.safeParse(parseJson(item.auditSnapshot, null));
  return {
    ...item,
    evidence: evidence.success ? evidence.data : null,
    composition: composition.success ? composition.data : parseCompositionSnapshot(item.compositionSnapshot, planType, item.finalText ?? ""),
    audit: audit.success ? audit.data : null,
  };
}

export function toFeedbackPlanDetail<T extends {
  type: string;
  items: Array<{
    evidenceSnapshot: string;
    compositionSnapshot: string;
    auditSnapshot: string;
    finalText?: string | null;
  }>;
}>(plan: T) {
  return {
    ...plan,
    items: plan.items.map((item) => toFeedbackPlanItemView(item, plan.type)),
  };
}

function planAnchorSession(input: FeedbackPlanCreateInput) {
  return input.sessionId ?? input.rangeEndSessionId ?? input.rangeStartSessionId;
}

async function resolveSession(db: FeedbackPlanDb, value: string | undefined) {
  if (!value) return null;
  const byId = await db.classSession.findUnique({
    where: { id: value },
    select: { id: true, code: true, classId: true, semesterId: true, date: true, semesterNumber: true },
  });
  return byId ?? db.classSession.findUnique({
    where: { code: value },
    select: { id: true, code: true, classId: true, semesterId: true, date: true, semesterNumber: true },
  });
}

async function assertPlanScope(db: FeedbackPlanDb, input: FeedbackPlanCreateInput) {
  if (!planAnchorSession(input)) throw new ApiError("反馈计划必须关联课次或阶段范围", 400, "invalid_request", false);
  const values = [input.sessionId, input.rangeStartSessionId, input.rangeEndSessionId].filter((value): value is string => Boolean(value));
  if (values.length) {
    const sessions = await Promise.all(values.map((value) => resolveSession(db, value)));
    if (sessions.some((session) => !session)) throw new ApiError("反馈计划引用的课次不存在", 404, "not_found", false);
    if (sessions.some((session) => session && (session.classId !== input.classId || session.semesterId !== input.semesterId))) {
      throw new ApiError("反馈计划引用的课次必须属于同一班级和学期", 400, "invalid_request", false);
    }
  }
  if (input.studentIds?.length) {
    const studentIds = [...new Set(input.studentIds)];
    const anchor = await resolveSession(db, planAnchorSession(input));
    const students = await db.student.findMany({
      where: {
        id: { in: studentIds },
        OR: [
          semesterStudentWhere({ semesterId: input.semesterId, classId: input.classId, studentIds }),
          ...(anchor ? [
            { sessionMetrics: { some: { sessionId: anchor.id } } },
            { attendances: { some: { sessionId: anchor.id } } },
            { events: { some: { sessionId: anchor.id } } },
            { communications: { some: { sessionId: anchor.id } } },
          ] : []),
        ],
      },
      select: { id: true },
    });
    if (students.length !== studentIds.length) throw new ApiError("反馈计划包含不属于当前班级的学生", 400, "invalid_request", false);
  }
}

function evidenceFromStudent(input: {
  planType: FeedbackPlanCreateInput["type"];
  student: FeedbackContextStudent | null;
  sourceFingerprint: string;
  existingTaskIds?: string[];
  assessmentEvidence?: StudentAssessmentEvidence[];
  preservedAssessmentEvidence?: FeedbackEvidenceBundle["assessmentEvidence"];
}): FeedbackEvidenceBundle {
  const student = input.student;
  const current = student?.rawMetrics.current;
  const currentEvents = current?.events ?? [];
  const currentEventRefs = current?.eventRefs ?? [];
  const currentEventIds = new Set(currentEventRefs.map((event) => event.id));
  const rangeEvents = (input.planType === "stage_trend" || input.planType === "course_end")
    ? (student?.rawMetrics.recentEventRefs ?? []).filter((event) => !currentEventIds.has(event.id))
    : [];
  const teacherInterventionEvents = currentEventRefs.concat(rangeEvents).filter((event) => event.type === "教师处理" || (event.description.startsWith("观察问题：") && event.description.includes("教师处理：")));
  const isTeacherIntervention = (content: string, index: number) => Boolean(currentEventRefs[index]?.type === "教师处理" || teacherInterventionEvents.some((event) => event.description === content));
  const teachingEvidence = student
    ? [
      ...currentEvents.map((content, index) => ({
        id: isTeacherIntervention(content, index) ? `teacher-intervention-${index}` : `current-event-${index}`,
        kind: isTeacherIntervention(content, index) ? "teacher_judgment" as const : "fact" as const,
        content,
        sourceRefs: [{ type: isTeacherIntervention(content, index) ? "teacher-intervention" : "session-event", id: currentEventRefs[index]!.id, label: isTeacherIntervention(content, index) ? "已确认教师处理" : "本次课堂记录" }],
        confirmed: true,
      })),
      ...rangeEvents.map((event, index) => ({
        id: `range-event-${index}`,
        kind: event.type === "教师处理" || (event.description.startsWith("观察问题：") && event.description.includes("教师处理："))
          ? "teacher_judgment" as const
          : "fact" as const,
        content: `${event.date ? `${event.date}：` : ""}${event.description}`,
        sourceRefs: [{ type: event.type === "教师处理" ? "teacher-intervention" : "session-event", id: event.id, label: event.type === "教师处理" ? "已确认教师处理" : "阶段课堂记录" }],
        occurredAt: event.date,
        confirmed: true,
      })),
      ...(current?.scoreA !== null && current?.scoreA !== undefined ? [{
        id: "current-score-a",
        kind: "fact" as const,
        content: `本次学习测验 ${current.scoreA} 分`,
        sourceRefs: [{ type: "session-metric", id: current.metricId!, label: "本次学习评价" }],
        confirmed: true,
      }] : []),
      ...(current?.scoreB !== null && current?.scoreB !== undefined ? [{
        id: "current-score-b",
        kind: "fact" as const,
        content: `本次课堂状态 ${current.scoreB} 分`,
        sourceRefs: [{ type: "session-metric", id: current.metricId!, label: "本次课堂评价" }],
        confirmed: true,
      }] : []),
      ...(input.planType === "stage_trend" || input.planType === "course_end"
        ? student.rawMetrics.recent.map((metric) => ({
          id: `recent-metric-${metric.metricId}`,
          kind: "fact" as const,
          content: `${metric.date} 第${metric.semesterNumber}次课：学习测验 ${metric.scoreA} 分，课堂状态 ${metric.scoreB} 分，课后任务 ${metric.scoreC} 分`,
          sourceRefs: [{ type: "session-metric", id: metric.metricId!, label: "近期评价趋势" }],
          occurredAt: metric.date,
          confirmed: true,
        }))
        : []),
      ...((input.planType === "stage_trend" || input.planType === "course_end") && student.rawMetrics.performanceBaseline.semesterValidCount > 0 ? [{
        id: "performance-baseline",
        kind: "fact" as const,
        content: `学期已有 ${student.rawMetrics.performanceBaseline.semesterValidCount} 次有效学习评价，近期两次 ${student.rawMetrics.performanceBaseline.recentAverageA ?? "暂无"} 分，学期平均 ${student.rawMetrics.performanceBaseline.semesterAverageA ?? "暂无"} 分`,
        sourceRefs: [{ type: "derived-baseline", id: student.id, label: "确定性趋势基线" }],
        confirmed: true,
      }] : []),
    ]
    : [];
  const communicationContext = student?.rawMetrics.communications.map((item) => ({
    id: `communication-${item.id}`,
    kind: "fact" as const,
    content: `${item.date} 与${item.target}：${item.summary}`,
    sourceRefs: [{ type: "communication", id: item.id!, label: "近期家校沟通" }],
    occurredAt: item.date,
    confirmed: true,
  })) ?? [];
  const assessmentEvidence = input.assessmentEvidence
    ? assessmentEvidenceItems(input.assessmentEvidence)
    : input.preservedAssessmentEvidence ?? [];
  const allEvidence: FeedbackEvidenceBundle["teachingEvidence"] = [
    ...teachingEvidence,
    ...assessmentEvidence,
    ...communicationContext,
  ];
  return FeedbackEvidenceBundleSchema.parse({
    version: 1,
    planType: input.planType,
    studentId: student?.id ?? null,
    teachingEvidence,
    assessmentEvidence,
    communicationContext,
    executionConstraints: {
      existingTaskIds: input.existingTaskIds ?? [],
      fixedArrangementRefs: [],
      teacherInterventionPresent: teacherInterventionEvents.length > 0,
    },
    sourceRefs: [
      ...(student ? [{ type: "student", id: student.id, label: student.name }] : []),
      ...allEvidence.flatMap((entry) => entry.sourceRefs),
    ],
    sourceFingerprint: input.sourceFingerprint,
  });
}

function evidenceFromClassContext(input: {
  planType: FeedbackPlanCreateInput["type"];
  students: FeedbackContextStudent[];
  sessionId?: string;
  sourceFingerprint: string;
  existingTaskIds?: string[];
}) : FeedbackEvidenceBundle {
  const evidence = input.students.flatMap((student) => [
    ...student.rawMetrics.current.events.slice(0, 4).map((content, index) => ({
      id: `class-event-${student.id}-${index}`,
      kind: content.startsWith("观察问题：") && content.includes("教师处理：") ? "teacher_judgment" as const : "fact" as const,
      content: `${student.name}：${content}`,
      sourceRefs: [{ type: "session-event", id: student.rawMetrics.current.eventRefs![index]!.id, label: "本次班级课堂记录" }],
      confirmed: true,
    })),
    ...(student.rawMetrics.current.scoreA !== null ? [{
      id: `class-score-a-${student.id}`,
      kind: "fact" as const,
      content: `${student.name} 本次学习测验 ${student.rawMetrics.current.scoreA} 分`,
      sourceRefs: [{ type: "session-metric", id: student.rawMetrics.current.metricId!, label: "本次班级评价" }],
      confirmed: true,
    }] : []),
  ]);
  return FeedbackEvidenceBundleSchema.parse({
    version: 1,
    planType: input.planType,
    studentId: null,
    teachingEvidence: evidence.slice(0, 100),
    assessmentEvidence: [],
    communicationContext: [],
    executionConstraints: {
      existingTaskIds: input.existingTaskIds ?? [],
      fixedArrangementRefs: [],
      teacherInterventionPresent: evidence.some((item) => item.kind === "teacher_judgment"),
    },
    sourceRefs: [
      { type: "class-session", id: input.sessionId!, label: "本次班级课堂记录" },
      ...evidence.flatMap((entry) => entry.sourceRefs),
    ],
    sourceFingerprint: input.sourceFingerprint,
  });
}

async function findContextForPlan(db: FeedbackPlanDb, input: FeedbackPlanCreateInput) {
  const anchor = planAnchorSession(input);
  if (!anchor) return null;
  const session = await db.classSession.findUnique({ where: { id: anchor }, select: { id: true, code: true, classId: true, semesterId: true, date: true, semesterNumber: true } })
    ?? await db.classSession.findUnique({ where: { code: anchor }, select: { id: true, code: true, classId: true, semesterId: true, date: true, semesterNumber: true } });
  if (!session) throw new ApiError("课次不存在", 404, "not_found", false);
  const sessions = await db.classSession.findMany({
    where: { classId: input.classId, semesterId: input.semesterId },
    select: { id: true, date: true, semesterNumber: true },
    orderBy: [{ date: "asc" }, { semesterNumber: "asc" }, { createdAt: "asc" }],
  });
  const startIndex = input.rangeStartSessionId ? sessions.findIndex((item) => item.id === input.rangeStartSessionId) : -1;
  const endIndex = input.rangeEndSessionId ? sessions.findIndex((item) => item.id === input.rangeEndSessionId) : -1;
  if (startIndex >= 0 && endIndex >= 0 && startIndex > endIndex) {
    throw new ApiError("反馈计划起始课次不能晚于截止课次", 400, "invalid_request", false);
  }
  const rangeSessionIds = startIndex >= 0 && endIndex >= 0
    ? sessions.slice(startIndex, endIndex + 1).map((item) => item.id)
    : input.type === "stage_trend" || input.type === "course_end"
      ? sessions.filter((item) => item.id === session.id || (item.date < session.date || (item.date === session.date && item.semesterNumber <= session.semesterNumber))).slice(-(input.type === "stage_trend" ? 4 : sessions.length)).map((item) => item.id)
      : undefined;
  return buildFeedbackContext(db, session.code, {
    ...(rangeSessionIds?.length ? { sessionIds: rangeSessionIds } : {}),
    ...(input.studentIds?.length ? { includeStudentIds: input.studentIds } : {}),
  });
}

function candidateStudentIds(input: FeedbackPlanCreateInput, context: Awaited<ReturnType<typeof buildFeedbackContext>> | null) {
  if (input.studentIds) return [...new Set(input.studentIds)];
  if (input.type === "class_update") return [null];
  return context?.students
    .filter((student) => input.type === "event_micro"
      ? student.feedbackRecommendationReasons.length > 0
      : student.rawMetrics.recent.length > 0 || student.rawMetrics.current.events.length > 0)
    .map((student) => student.id) ?? [];
}

export async function createFeedbackPlan(rawInput: FeedbackPlanCreateInput, db: PrismaClient = prisma) {
  const parsedInput = FeedbackPlanCreateSchema.parse(rawInput);
  await assertPlanScope(db, parsedInput);
  const input = {
    ...parsedInput,
    sessionId: (await resolveSession(db, parsedInput.sessionId))?.id ?? parsedInput.sessionId,
    rangeStartSessionId: (await resolveSession(db, parsedInput.rangeStartSessionId))?.id ?? parsedInput.rangeStartSessionId,
    rangeEndSessionId: (await resolveSession(db, parsedInput.rangeEndSessionId))?.id ?? parsedInput.rangeEndSessionId,
  } satisfies FeedbackPlanCreateInput;
  let context = await findContextForPlan(db, input);
  let rangeStartSessionId = input.rangeStartSessionId;
  const rangeEndSessionId = input.rangeEndSessionId ?? ((input.type === "stage_trend" || input.type === "course_end") ? input.sessionId : undefined);
  const anchorId = rangeEndSessionId ?? input.sessionId;
  const anchorSession = anchorId
    ? await db.classSession.findUnique({ where: { id: anchorId }, select: { id: true, date: true, semesterNumber: true } })
    : null;
  if (input.type === "stage_trend" && !rangeStartSessionId) {
    const previous = await db.feedbackPlan.findFirst({
      where: { classId: input.classId, semesterId: input.semesterId, type: "stage_trend", status: { in: ["approved", "partially_exported", "exported"] } },
      orderBy: { updatedAt: "desc" },
      select: { rangeEndSessionId: true },
    });
    if (previous?.rangeEndSessionId) {
      const previousEnd = await db.classSession.findUnique({ where: { id: previous.rangeEndSessionId }, select: { date: true, semesterNumber: true } });
      const next = await db.classSession.findFirst({
        where: {
          classId: input.classId,
          semesterId: input.semesterId,
          ...(previousEnd ? { OR: [{ date: { gt: previousEnd.date } }, { date: previousEnd.date, semesterNumber: { gt: previousEnd.semesterNumber } }] } : {}),
          ...(anchorSession ? { AND: [{ OR: [{ date: { lt: anchorSession.date } }, { date: anchorSession.date, semesterNumber: { lte: anchorSession.semesterNumber } }] }] } : {}),
        },
        orderBy: [{ date: "asc" }, { semesterNumber: "asc" }],
        select: { id: true },
      });
      if (!next) throw new ApiError("上一份阶段反馈之后没有新的课次，请调整阶段范围", 409, "conflict", false);
      rangeStartSessionId = next.id;
    } else {
      const sessions = await db.classSession.findMany({
        where: {
          classId: input.classId,
          semesterId: input.semesterId,
          ...(anchorSession ? { OR: [{ date: { lt: anchorSession.date } }, { date: anchorSession.date, semesterNumber: { lte: anchorSession.semesterNumber } }] } : {}),
        },
        orderBy: [{ date: "desc" }, { semesterNumber: "desc" }],
        take: 4,
        select: { id: true },
      });
      rangeStartSessionId = sessions.at(-1)?.id;
    }
  }
  if (input.type === "course_end" && !rangeStartSessionId) {
    rangeStartSessionId = (await db.classSession.findFirst({
      where: { classId: input.classId, semesterId: input.semesterId },
      orderBy: [{ date: "asc" }, { semesterNumber: "asc" }],
      select: { id: true },
    }))?.id;
  }

  // 先确定真实范围，再组装证据；否则阶段/结课计划会错误地复用当前课次的五次近期上下文。
  context = await findContextForPlan(db, {
    ...input,
    rangeStartSessionId,
    rangeEndSessionId,
  });
  const selectedIds = candidateStudentIds(input, context);
  if (!selectedIds.length) throw new ApiError("没有可加入反馈计划的学生", 400, "invalid_request", false);
  const assessmentByStudent = normalizePlanAssessmentEvidence({
    assessmentEvidence: input.assessmentEvidence,
    sessionCode: context?.session.code ?? "",
    allowedStudentIds: selectedIds.filter((studentId): studentId is string => Boolean(studentId)),
  });
  const contextByStudent = new Map(context?.students.map((student) => [student.id, student]) ?? []);
  const existingTasks = await db.teacherTask.findMany({
    where: {
      classId: input.classId,
      status: "pending",
      ...(selectedIds.some((id) => id === null)
        ? {}
        : { studentId: { in: selectedIds.filter((id): id is string => Boolean(id)) } }),
    },
    select: { id: true, studentId: true },
  });
  const taskIdsByStudent = new Map<string | null, string[]>();
  for (const task of existingTasks) {
    const key = task.studentId ?? null;
    taskIdsByStudent.set(key, [...(taskIdsByStudent.get(key) ?? []), task.id]);
  }

  const sourceFingerprint = sha256(JSON.stringify({
    input,
    rangeStartSessionId,
    rangeEndSessionId,
    context: context?.students.map((student) => ({
      id: student.id,
      promptContext: student.promptContext,
      communicationPreference: student.communicationPreference ?? null,
    })) ?? [],
    executionConstraints: {
      existingTaskIds: existingTasks.map((task) => task.id).sort(),
      fixedArrangementRefs: [],
    },
    assessmentEvidence: assessmentByStudent,
  }));

  const created = await db.$transaction(async (tx) => {
    const plan = await tx.feedbackPlan.create({
      data: {
        type: input.type,
        purpose: input.purpose,
        semesterId: input.semesterId,
        classId: input.classId,
        sessionId: input.sessionId,
        rangeStartSessionId,
        rangeEndSessionId,
        inputFingerprint: sourceFingerprint,
        items: {
          create: selectedIds.map((studentId) => {
            const student = studentId ? contextByStudent.get(studentId) ?? null : null;
            const bundle = input.type === "class_update"
              ? evidenceFromClassContext({ planType: input.type, students: context?.students ?? [], sessionId: input.sessionId ?? rangeEndSessionId, sourceFingerprint, existingTaskIds: taskIdsByStudent.get(null) })
              : evidenceFromStudent({
                planType: input.type,
                student,
                sourceFingerprint,
                existingTaskIds: taskIdsByStudent.get(studentId),
                assessmentEvidence: studentId ? assessmentByStudent[studentId] : undefined,
              });
            return { studentId, evidenceSnapshot: json(bundle) };
          }),
        },
      },
      include: { items: true },
    });
    return plan;
  });
  const detail = await getFeedbackPlan(created.id, db);
  if (!detail) throw new Error("反馈计划创建后无法读取");
  return detail;
}

export async function getFeedbackPlan(id: string, db: PrismaClient = prisma) {
  const plan = await db.feedbackPlan.findUnique({
    where: { id },
    include: {
      items: { include: { student: { include: { communicationPreference: true, communicationPreferenceCandidates: { where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 1 } } }, tasks: true, attachments: true, selectedGeneration: true } },
      tasks: true,
      attachments: true,
      exportRuns: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!plan) return null;
  const checked = await validateFeedbackPlanAttachments(id, db);
  if (checked.some((entry) => plan.attachments.some((attachment) => attachment.id === entry.id && attachment.status !== entry.status))) {
    return db.feedbackPlan.findUnique({
      where: { id },
      include: { items: { include: { student: { include: { communicationPreference: true, communicationPreferenceCandidates: { where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 1 } } }, tasks: true, attachments: true, selectedGeneration: true } }, tasks: true, attachments: true, exportRuns: { orderBy: { createdAt: "desc" } } },
    });
  }
  return plan;
}

export async function listFeedbackPlans(input: { classId?: string; semesterId?: string; type?: string }, db: PrismaClient = prisma) {
  return db.feedbackPlan.findMany({
    where: {
      ...(input.classId ? { classId: input.classId } : {}),
      ...(input.semesterId ? { semesterId: input.semesterId } : {}),
      ...(input.type ? { type: input.type } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: { items: { select: { id: true, studentId: true, status: true, finalTextHash: true, updatedAt: true } } },
  });
}

export async function patchFeedbackPlanItem(id: string, rawPatch: FeedbackPlanItemPatch, db: PrismaClient = prisma) {
  const patch = FeedbackPlanItemPatchSchema.parse(rawPatch);
  const item = await db.feedbackPlanItem.findUnique({ include: { plan: { include: { items: { include: { student: true } } } }, student: true, tasks: true } , where: { id } });
  if (!item) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
  if (["approved", "exported"].includes(item.status)) throw new ApiError("已批准或已导出的反馈不可原位修改，请新建反馈计划", 409, "conflict", false);
  if (item.status === "generating") throw new ApiError("反馈正在生成，请刷新计划后重试", 409, "conflict", false);
  if (patch.expectedItemRevision && patch.expectedItemRevision !== item.itemRevision) throw new ApiError("反馈计划条目已被其他操作更新", 409, "conflict", false);
  const bundle = FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {}));
  const composition = patch.composition ?? parseCompositionSnapshot(item.compositionSnapshot, item.plan.type, patch.finalText ?? item.finalText ?? "");
  const finalText = patch.finalText ?? composition.draftFeedback;
  const normalizedFinalText = normalizedCoverageText(finalText);
  const evidenceCoverage = patch.finalText === undefined
    ? composition.evidenceCoverage
    : composition.evidenceCoverage.filter((coverage) => normalizedFinalText.includes(normalizedCoverageText(coverage.statement)));
  const nextComposition = FeedbackCompositionPlanSchema.parse({ ...composition, evidenceCoverage, draftFeedback: finalText });
  const taskIds = activeTaskIds(item.tasks);
  const otherStudentNames = item.plan.items.flatMap((entry) => entry.id !== item.id && entry.student?.name ? [entry.student.name] : []);
  const audit = createAuditSnapshot(nextComposition, bundle, taskIds, { studentName: item.student?.name ?? undefined, otherStudentNames });
  const reviewMode = patch.reviewMode ?? (patch.finalText !== undefined ? "teacher_edited" : item.reviewMode);
  const status = audit.status === "blocked" ? "needs_review" : "needs_review";

  return db.feedbackPlanItem.update({
    where: { id },
    data: {
      compositionSnapshot: json(nextComposition),
      auditSnapshot: json(audit),
      finalText,
      finalTextHash: sha256(finalText),
      reviewMode,
      status,
      itemRevision: { increment: 1 },
      plan: { update: { planRevision: { increment: 1 }, status: "in_review", approvedAt: null, exportedAt: null } },
    },
    include: { tasks: true },
  });
}

/**
 * Keep already generated text after a teacher acknowledges a non-destructive
 * context change. This never calls the model or changes the evidence snapshot.
 */
export async function retainStaleFeedbackPlanItems(input: {
  planId: string;
  itemIds?: string[];
}, db: PrismaClient = prisma) {
  const requestedIds = input.itemIds ? [...new Set(input.itemIds)] : undefined;
  const items = await db.feedbackPlanItem.findMany({
    where: {
      planId: input.planId,
      status: "stale",
      ...(requestedIds ? { id: { in: requestedIds } } : {}),
    },
    select: { id: true, finalText: true },
  });
  const retainedIds = items.filter((item) => Boolean(item.finalText?.trim())).map((item) => item.id);
  if (!retainedIds.length) throw new ApiError("没有可保留的已生成正文", 409, "conflict", false);
  await db.$transaction(async (tx) => {
    await tx.feedbackPlanItem.updateMany({
      where: { id: { in: retainedIds }, planId: input.planId, status: "stale" },
      data: { status: "needs_review", reviewMode: "teacher_edited", itemRevision: { increment: 1 } },
    });
    const planItems = await tx.feedbackPlanItem.findMany({ where: { planId: input.planId }, select: { status: true } });
    await tx.feedbackPlan.update({
      where: { id: input.planId },
      data: { status: derivePlanStatus(planItems), planRevision: { increment: 1 }, approvedAt: null, exportedAt: null },
    });
  });
  const plan = await getFeedbackPlan(input.planId, db);
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  return plan;
}

export async function createTeacherTask(input: {
  planItemId: string;
  action: string;
  dueType: "date" | "session";
  dueDate?: string;
  dueSessionId?: string;
  estimatedMinutes?: number;
  promiseExcerpt?: string;
}, db: PrismaClient = prisma) {
  const item = await db.feedbackPlanItem.findUnique({
    where: { id: input.planItemId },
    include: {
      plan: { include: { session: true, rangeEndSession: true, items: { include: { student: true } } } },
      student: true,
      tasks: true,
    },
  });
  if (!item) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
  if (item.status !== "needs_review") throw new ApiError("只有待教师审核的反馈才能批准未来任务", 409, "conflict", false);
  if (!input.action.trim()) throw new ApiError("教师任务不能为空", 400, "invalid_request", false);
  if (input.dueType === "date" && !input.dueDate) throw new ApiError("日期任务缺少截止日期", 400, "invalid_request", false);
  let resolvedDueSessionId = input.dueSessionId;
  if (input.dueType === "session" && !resolvedDueSessionId) {
    const anchor = item.plan.rangeEndSession ?? item.plan.session;
    if (!anchor) throw new ApiError("没有可推断的后续课次，请选择日期或课次", 400, "invalid_request", false);
    const nextSession = await db.classSession.findFirst({
      where: {
        classId: item.plan.classId,
        semesterId: item.plan.semesterId,
        OR: [{ date: { gt: anchor.date } }, { date: anchor.date, semesterNumber: { gt: anchor.semesterNumber } }],
      },
      orderBy: [{ date: "asc" }, { semesterNumber: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    resolvedDueSessionId = nextSession?.id;
  }
  if (input.dueType === "session" && !resolvedDueSessionId) throw new ApiError("没有下一节同班课次，请选择日期或课次", 400, "invalid_request", false);
  if (input.dueType === "session" && resolvedDueSessionId) {
    const dueSession = await db.classSession.findFirst({ where: { id: resolvedDueSessionId, classId: item.plan.classId, semesterId: item.plan.semesterId }, select: { id: true, date: true, semesterNumber: true } });
    if (!dueSession) throw new ApiError("截止课次必须属于同一班级和学期", 400, "invalid_request", false);
    const anchor = item.plan.rangeEndSession ?? item.plan.session;
    if (anchor && (dueSession.date < anchor.date || (dueSession.date === anchor.date && dueSession.semesterNumber <= anchor.semesterNumber))) {
      throw new ApiError("教师任务截止课次必须晚于反馈计划课次", 400, "invalid_request", false);
    }
  }
  return db.$transaction(async (tx) => {
    const currentItem = await tx.feedbackPlanItem.findUnique({ where: { id: item.id }, select: { status: true, itemRevision: true } });
    if (!currentItem || currentItem.status !== "needs_review" || currentItem.itemRevision !== item.itemRevision) {
      throw new ApiError("反馈条目已被其他操作更新，请刷新后再批准教师任务", 409, "conflict", false);
    }
    const task = await tx.teacherTask.create({
      data: {
        planId: item.planId,
        planItemId: item.id,
        studentId: item.studentId,
        classId: item.plan.classId,
        action: input.action.trim(),
        promiseExcerpt: input.promiseExcerpt?.trim() || null,
        dueType: input.dueType,
        dueDate: input.dueDate ?? null,
        dueSessionId: resolvedDueSessionId ?? null,
        estimatedMinutes: input.estimatedMinutes ?? null,
        sourceHash: item.finalTextHash,
        approvedAt: new Date(),
      },
    });
    const bundle = FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {}));
    const composition = parseCompositionSnapshot(item.compositionSnapshot, item.plan.type, item.finalText ?? "");
    const audit = createAuditSnapshot(
      composition,
      bundle,
      new Set([...activeTaskIds(item.tasks), task.id]),
      {
        studentName: item.student?.name ?? undefined,
        otherStudentNames: item.plan.items.flatMap((entry) => entry.studentId && entry.studentId !== item.studentId && entry.student?.name ? [entry.student.name] : []),
      },
    );
    await tx.feedbackPlanItem.update({
      where: { id: item.id },
      data: { auditSnapshot: json(audit), status: audit.status === "blocked" ? "needs_review" : "needs_review", itemRevision: { increment: 1 } },
    });
    return task;
  });
}

export async function approveFeedbackPlanItems(input: { planId: string; itemIds?: string[]; expectedHashes?: Record<string, string> }, db: PrismaClient = prisma) {
  const approved = await db.$transaction(async (tx) => {
    const plan = await tx.feedbackPlan.findUnique({ where: { id: input.planId }, include: { items: { include: { tasks: true, student: true } } } });
    if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    const itemIds = input.itemIds ? new Set(input.itemIds) : new Set(plan.items.map((item) => item.id));
    const selected = plan.items.filter((item) => itemIds.has(item.id));
    if (!selected.length) throw new ApiError("没有要批准的反馈条目", 400, "invalid_request", false);
    const failures: string[] = [];
    for (const item of selected) {
      const itemLabel = item.student?.name ?? "班级公共反馈";
      if (item.status === "stale" || item.status === "generating") {
        failures.push(`${itemLabel}：当前状态为${item.status}，请先完成生成或重新组装`);
        continue;
      }
      const expected = input.expectedHashes?.[item.id];
      if (!expected || expected !== item.finalTextHash) {
        failures.push(`${itemLabel}：文本已变化，请重新检查`);
        continue;
      }
      const audit = parseJson(item.auditSnapshot, null as ReturnType<typeof createAuditSnapshot> | null);
      const bundle = FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {}));
      const composition = parseCompositionSnapshot(item.compositionSnapshot, plan.type, item.finalText ?? "");
      const recalculatedAudit = createAuditSnapshot(
        composition,
        bundle,
        activeTaskIds(item.tasks),
        { studentName: item.student?.name ?? undefined, otherStudentNames: plan.items.flatMap((entry) => entry.studentId && entry.studentId !== item.studentId && entry.student?.name ? [entry.student.name] : []) },
      );
      const hardBlocked = recalculatedAudit.items.filter((issue) => isHardFeedbackAuditIssue(issue.code));
      if (!item.finalText?.trim() || !item.finalTextHash || !audit || audit.textHash !== item.finalTextHash || recalculatedAudit.textHash !== item.finalTextHash || hardBlocked.length > 0) {
        const blocked = hardBlocked
          .map((issue) => issue.message);
        failures.push(`${itemLabel}：${blocked.join("、") || "未通过文本哈希或程序门禁"}`);
      }
    }
    if (failures.length) {
      throw new ApiError(`以下条目暂不能批准：${failures.join("；")}`, 409, "conflict", false, { failures });
    }
    await Promise.all(selected.map((item) => tx.feedbackPlanItem.update({
      where: { id: item.id },
      data: { status: "approved", approvedAt: new Date() },
    })));
    const nextItems = plan.items.map((item) => itemIds.has(item.id) ? { status: "approved" } : item);
    const status = derivePlanStatus(nextItems);
    const allApproved = nextItems.every((item) => item.status === "approved" || item.status === "exported");
    return tx.feedbackPlan.update({ where: { id: plan.id }, data: { status, approvedAt: allApproved ? new Date() : null }, include: { items: true } });
  });
  const detail = await getFeedbackPlan(approved.id, db);
  if (!detail) throw new Error("反馈计划批准后无法读取");
  return detail;
}

export async function updateTeacherTaskStatus(id: string, status: "pending" | "completed" | "cancelled", db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const task = await tx.teacherTask.update({
      where: { id },
      data: { status, completedAt: status === "completed" ? new Date() : null },
      include: {
        planItem: {
          include: {
            tasks: true,
            student: true,
            plan: { include: { items: { include: { student: true } } } },
          },
        },
      },
    });
    const item = task.planItem;
    if (item && ["evidence_ready", "needs_review"].includes(item.status)) {
      const bundle = FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {}));
      const composition = parseCompositionSnapshot(item.compositionSnapshot, item.plan.type, item.finalText ?? "");
      const currentTasks = item.tasks.map((entry) => entry.id === task.id ? { ...entry, status } : entry);
      const audit = createAuditSnapshot(
        composition,
        bundle,
        activeTaskIds(currentTasks),
        {
          studentName: item.student?.name ?? undefined,
          otherStudentNames: item.plan.items.flatMap((entry) => entry.studentId && entry.studentId !== item.studentId && entry.student?.name ? [entry.student.name] : []),
        },
      );
      await tx.feedbackPlanItem.update({
        where: { id: item.id },
        data: { auditSnapshot: json(audit), status: "needs_review", itemRevision: { increment: 1 } },
      });
      const planItems = await tx.feedbackPlanItem.findMany({ where: { planId: item.planId }, select: { status: true } });
      await tx.feedbackPlan.update({ where: { id: item.planId }, data: { status: derivePlanStatus(planItems), planRevision: { increment: 1 } } });
    }
    return task;
  });
}

/**
 * Mark only mutable feedback-plan revisions stale after confirmed source changes.
 * Approved/exported history is immutable; a later generation gets a new revision.
 */
export async function invalidateFeedbackPlans(input: {
  classId?: string;
  semesterId?: string;
  sessionId?: string;
  studentIds?: string[];
}, db: FeedbackPlanDb = prisma) {
  const studentIds = [...new Set(input.studentIds ?? [])];
  const targetSession = input.sessionId
    ? await db.classSession.findUnique({ where: { id: input.sessionId }, select: { id: true, classId: true, semesterId: true, date: true, semesterNumber: true } })
    : null;
  const classId = input.classId ?? targetSession?.classId ?? undefined;
  const semesterId = input.semesterId ?? targetSession?.semesterId ?? undefined;
  const plans = await db.feedbackPlan.findMany({
    where: {
      ...(classId ? { classId } : {}),
      ...(semesterId ? { semesterId } : {}),
      items: { some: { status: { in: ["evidence_ready", "generating", "needs_review"] } } },
    },
    select: {
      id: true,
      sessionId: true,
      rangeStartSessionId: true,
      rangeEndSessionId: true,
      session: { select: { date: true, semesterNumber: true } },
      rangeStartSession: { select: { date: true, semesterNumber: true } },
      rangeEndSession: { select: { date: true, semesterNumber: true } },
      items: { select: { id: true, studentId: true, status: true } },
    },
  });
  const position = (session: { date: string; semesterNumber: number } | null | undefined) => session
    ? `${session.date}|${String(session.semesterNumber).padStart(6, "0")}`
    : null;
  const targetPosition = targetSession ? position(targetSession) : null;
  const matchingPlanIds = new Set(plans.filter((plan) => {
    if (!input.sessionId) return true;
    if (plan.sessionId === input.sessionId) return true;
    if (!targetPosition) return false;
    const start = position(plan.rangeStartSession);
    const end = position(plan.rangeEndSession);
    return Boolean(start && end && targetPosition >= start && targetPosition <= end);
  }).map((plan) => plan.id));
  const itemIds = plans.flatMap((plan) => matchingPlanIds.has(plan.id)
    ? plan.items.filter((item) => (
      ["evidence_ready", "generating", "needs_review"].includes(item.status)
      && (studentIds.length > 0
        ? Boolean(item.studentId && studentIds.includes(item.studentId)) || Boolean(input.sessionId && item.studentId === null)
        : true)
    )).map((item) => item.id)
    : []);
  if (itemIds.length === 0) return 0;
  const updated = await db.feedbackPlanItem.updateMany({ where: { id: { in: itemIds } }, data: { status: "stale" } });
  if (updated.count > 0) {
    await db.feedbackPlan.updateMany({ where: { id: { in: [...matchingPlanIds] } }, data: { status: "stale" } });
  }
  return updated.count;
}

export async function listTeacherTasks(input: { semesterId?: string; classId?: string; status?: string }, db: PrismaClient = prisma) {
  return db.teacherTask.findMany({
    where: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.classId ? { classId: input.classId } : {}),
      ...(input.semesterId ? { plan: { semesterId: input.semesterId } } : {}),
    },
    include: {
      student: { select: { id: true, name: true } },
      dueSession: { select: { id: true, code: true, date: true, semesterNumber: true } },
      plan: { select: { id: true, type: true, purpose: true } },
    },
    orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
}

function feedbackAttachmentRoot() {
  return path.resolve(process.env.STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT?.trim()
    || path.join(os.homedir(), "Library", "Application Support", "Student Track", "feedback-attachments"));
}

function safeAttachmentName(name: string) {
  const base = path.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 160);
  return base || "attachment";
}

function attachmentDestination(planId: string, relativeLocator: string) {
  const prefix = `${path.posix.join("feedback-attachments", planId)}/`;
  if (!relativeLocator.startsWith(prefix)) throw new Error("附件定位符不在受控目录内");
  const filePart = relativeLocator.slice(prefix.length);
  if (!filePart || filePart.includes("..") || path.posix.isAbsolute(filePart)) throw new Error("附件定位符无效");
  const root = feedbackAttachmentRoot();
  const destination = path.resolve(root, planId, ...filePart.split("/"));
  const relative = path.relative(root, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("附件路径越界");
  return destination;
}

export async function validateFeedbackPlanAttachments(planId: string, db: PrismaClient = prisma) {
  const attachments = await db.feedbackAttachment.findMany({ where: { planId } });
  const result: Array<{ id: string; status: "available" | "missing" }> = [];
  for (const attachment of attachments) {
    let status: "available" | "missing" = "available";
    try {
      const destination = attachmentDestination(planId, attachment.relativeLocator);
      const bytes = await fs.readFile(destination);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== attachment.sizeBytes || hash !== attachment.sha256) status = "missing";
    } catch {
      status = "missing";
    }
    if (attachment.status !== status) await db.feedbackAttachment.update({ where: { id: attachment.id }, data: { status } });
    result.push({ id: attachment.id, status });
  }
  return result;
}

export async function addFeedbackAttachment(input: {
  planId: string;
  planItemId?: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}, db: PrismaClient = prisma) {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > 25 * 1024 * 1024) throw new ApiError("附件大小必须在 1B 到 25MB 之间", 400, "invalid_request", false);
  const plan = await db.feedbackPlan.findUnique({ where: { id: input.planId }, select: { id: true } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (input.planItemId) {
    const item = await db.feedbackPlanItem.findFirst({ where: { id: input.planItemId, planId: input.planId }, select: { id: true } });
    if (!item) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
  }
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const fileName = `${randomUUID()}-${safeAttachmentName(input.fileName)}`;
  const relativeLocator = path.posix.join("feedback-attachments", input.planId, fileName);
  const destination = path.join(feedbackAttachmentRoot(), input.planId, fileName);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, input.bytes, { mode: 0o600 });
  try {
    return await db.feedbackAttachment.create({
      data: {
        planId: input.planId,
        planItemId: input.planItemId,
        displayName: input.fileName.trim().slice(0, 200) || "attachment",
        mimeType: input.mimeType.trim().slice(0, 200) || "application/octet-stream",
        sizeBytes: input.bytes.byteLength,
        sha256: hash,
        relativeLocator,
      },
    });
  } catch (error) {
    await fs.unlink(destination).catch(() => undefined);
    throw error;
  }
}

export async function removeFeedbackAttachment(input: { planId: string; attachmentId: string }, db: PrismaClient = prisma) {
  const attachment = await db.feedbackAttachment.findFirst({ where: { id: input.attachmentId, planId: input.planId } });
  if (!attachment) throw new ApiError("反馈附件不存在", 404, "not_found", false);
  const destination = attachmentDestination(input.planId, attachment.relativeLocator);
  const quarantine = `${destination}.delete-${randomUUID()}`;
  let moved = false;
  try {
    await fs.rename(destination, quarantine);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await db.feedbackAttachment.delete({ where: { id: attachment.id } });
    if (moved) await fs.unlink(quarantine).catch(() => undefined);
    return { id: attachment.id, deleted: true };
  } catch (error) {
    if (moved) await fs.rename(quarantine, destination).catch(() => undefined);
    throw error;
  }
}

export async function deleteFeedbackPlan(id: string, db: PrismaClient = prisma) {
  const plan = await db.feedbackPlan.findUnique({ where: { id }, select: { id: true, attachments: { select: { relativeLocator: true } } } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  // Validate every persisted locator before moving anything. A corrupted row
  // must fail closed rather than allowing deletion to operate on an unknown
  // path, even though the normal plan directory is itself controlled.
  for (const attachment of plan.attachments) attachmentDestination(id, attachment.relativeLocator);
  const root = feedbackAttachmentRoot();
  const planDirectory = path.resolve(root, id);
  const relative = path.relative(root, planDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative !== id) throw new Error("反馈计划附件目录无效");
  const quarantineDirectory = path.resolve(root, `.deleted-${id}-${randomUUID()}`);
  let moved = false;
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    try { await fs.rename(planDirectory, quarantineDirectory); moved = true; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    await db.$transaction(async (tx) => {
      await tx.feedbackPlan.delete({ where: { id } });
    });
    if (moved) await fs.rm(quarantineDirectory, { recursive: true, force: true });
    return { id, deleted: true };
  } catch (error) {
    if (moved) await fs.rename(quarantineDirectory, planDirectory).catch(() => undefined);
    throw error;
  }
}

export async function generateFeedbackPlanItems(input: {
  planId: string;
  itemIds?: string[];
  assessmentEvidence?: FeedbackPlanAssessmentEvidenceInput;
  signal?: AbortSignal;
  onProgress?: (event: { type: "status" | "item"; message?: string; itemId?: string; status?: string; error?: string }) => void | Promise<void>;
}, db: PrismaClient = prisma) {
  let plan = await db.feedbackPlan.findUnique({ where: { id: input.planId }, include: { items: { include: { student: true, tasks: true } } } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  let selected = input.itemIds
    ? plan.items.filter((item) => input.itemIds!.includes(item.id))
    : plan.items;
  if (!selected.length) throw new ApiError("没有要生成的反馈条目", 400, "invalid_request", false);
  const immutable = selected.filter((item) => (
    item.status === "approved"
    || item.status === "exported"
    || (item.reviewMode === "teacher_edited" && item.status !== "stale")
  ));
  if (immutable.length) {
    throw new ApiError("已批准、已导出或教师已修改的反馈不能被批量覆盖；请批准当前文本，或新建计划保留历史版本", 409, "conflict", false);
  }

  const planInput: FeedbackPlanCreateInput = {
    type: plan.type as FeedbackPlanCreateInput["type"],
    purpose: plan.purpose,
    semesterId: plan.semesterId,
    classId: plan.classId,
    sessionId: plan.sessionId ?? undefined,
    rangeStartSessionId: plan.rangeStartSessionId ?? undefined,
    rangeEndSessionId: plan.rangeEndSessionId ?? undefined,
    studentIds: selected.flatMap((item) => item.studentId ? [item.studentId] : []),
  };
  const context = await findContextForPlan(db, planInput);
  const contextByStudent = new Map(context?.students.map((student) => [student.id, student]) ?? []);
  const normalizedAssessmentEvidence = normalizePlanAssessmentEvidence({
    assessmentEvidence: input.assessmentEvidence,
    sessionCode: context?.session.code ?? "",
    allowedStudentIds: selected.flatMap((item) => item.studentId ? [item.studentId] : []),
  });

  // A stale item must never reuse its old evidence snapshot. Rebase the
  // deterministic bundle first; this creates a new mutable item revision while
  // approved/exported history remains immutable.
  const staleItems = selected.filter((item) => item.status === "stale");
  if (staleItems.length) {
    const planBeforeRebase = plan;
    const pendingTasks = await db.teacherTask.findMany({
      where: { planId: plan.id, status: "pending" },
      select: { id: true, studentId: true },
    });
    const taskIdsByStudent = new Map<string | null, string[]>();
    for (const task of pendingTasks) {
      const key = task.studentId ?? null;
      taskIdsByStudent.set(key, [...(taskIdsByStudent.get(key) ?? []), task.id]);
    }
    const sourceFingerprint = sha256(JSON.stringify({
      input: planInput,
      context: context?.students.map((student) => ({
        id: student.id,
        promptContext: student.promptContext,
        communicationPreference: student.communicationPreference ?? null,
      })) ?? [],
      executionConstraints: { existingTaskIds: pendingTasks.map((task) => task.id).sort(), fixedArrangementRefs: [] },
      assessmentEvidence: normalizedAssessmentEvidence,
    }));
    await db.$transaction(async (tx) => {
      for (const item of staleItems) {
        const student = item.studentId ? contextByStudent.get(item.studentId) ?? null : null;
        const replacementAssessment = item.studentId ? normalizedAssessmentEvidence[item.studentId] : undefined;
        const preservedAssessment = replacementAssessment ? undefined : persistedAssessmentEvidence(item.evidenceSnapshot);
        const itemFingerprint = sha256(JSON.stringify({ sourceFingerprint, assessmentEvidence: replacementAssessment ?? preservedAssessment }));
        const bundle = planBeforeRebase.type === "class_update"
          ? evidenceFromClassContext({ planType: "class_update", students: context?.students ?? [], sessionId: planBeforeRebase.sessionId ?? planBeforeRebase.rangeEndSessionId ?? undefined, sourceFingerprint: itemFingerprint, existingTaskIds: taskIdsByStudent.get(null) })
          : evidenceFromStudent({
            planType: planBeforeRebase.type as FeedbackPlanCreateInput["type"],
            student,
            sourceFingerprint: itemFingerprint,
            existingTaskIds: taskIdsByStudent.get(item.studentId),
            assessmentEvidence: replacementAssessment,
            preservedAssessmentEvidence: preservedAssessment,
          });
        await tx.feedbackPlanItem.update({
          where: { id: item.id },
          data: {
            evidenceSnapshot: json(bundle),
            compositionSnapshot: "{}",
            auditSnapshot: "{}",
            finalText: null,
            finalTextHash: null,
            selectedGenerationId: null,
            reviewMode: "model",
            status: "evidence_ready",
            approvedAt: null,
            exportedAt: null,
            itemRevision: { increment: 1 },
          },
        });
      }
      await tx.feedbackPlan.update({
        where: { id: planBeforeRebase.id },
        data: { inputFingerprint: sourceFingerprint, status: "draft", planRevision: { increment: 1 }, approvedAt: null, exportedAt: null },
      });
    });
    plan = await db.feedbackPlan.findUnique({ where: { id: input.planId }, include: { items: { include: { student: true, tasks: true } } } });
    if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
    selected = input.itemIds
      ? plan.items.filter((item) => input.itemIds!.includes(item.id))
      : plan.items;
  }

  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);

  const assessmentBundleOverrides = new Map<string, FeedbackEvidenceBundle>();
  for (const item of selected) {
    if (!item.studentId || !Object.hasOwn(normalizedAssessmentEvidence, item.studentId)) continue;
    const student = contextByStudent.get(item.studentId) ?? null;
    const assessmentEvidence = normalizedAssessmentEvidence[item.studentId]!;
    const sourceFingerprint = sha256(JSON.stringify({
      planInput,
      studentId: item.studentId,
      promptContext: student?.promptContext ?? null,
      communicationPreference: student?.communicationPreference ?? null,
      existingTaskIds: [...activeTaskIds(item.tasks)].sort(),
      assessmentEvidence,
    }));
    assessmentBundleOverrides.set(item.id, evidenceFromStudent({
      planType: plan.type as FeedbackPlanCreateInput["type"],
      student,
      sourceFingerprint,
      existingTaskIds: [...activeTaskIds(item.tasks)],
      assessmentEvidence,
    }));
  }

  const unsupported = selected.filter((item) => !["evidence_ready", "needs_review"].includes(item.status));
  if (unsupported.length) throw new ApiError("反馈条目当前状态不能生成，请刷新计划后重试", 409, "conflict", false);
  const originalStates = new Map(selected.map((item) => [item.id, {
    status: item.status,
    approvedAt: item.approvedAt,
    exportedAt: item.exportedAt,
  }]));
  await db.$transaction(async (tx) => {
    const locked = await tx.feedbackPlanItem.updateMany({
      where: { id: { in: selected.map((item) => item.id) }, status: { in: ["evidence_ready", "needs_review"] } },
      data: { status: "generating" },
    });
    if (locked.count !== selected.length) throw new ApiError("反馈计划已被其他操作更新，请刷新后重试", 409, "conflict", false);
    await tx.feedbackPlan.update({ where: { id: plan.id }, data: { status: "generating" } });
  });
  const results = [];

  try {
    // Client/config creation is part of generation. Keep it inside the recovery
    // boundary so a missing model configuration cannot strand rows in
    // `generating`.
    const draftClient = createLLMClient("feedbackDraft");
    const reviewClient = createLLMClient("feedbackReview");
    const draftModel = getLLMModel("feedbackDraft");
    const reviewModel = getLLMModel("feedbackReview");
    await input.onProgress?.({ type: "status", message: `开始生成 ${selected.length} 条反馈` });
    const failures: Array<{ itemId: string; name: string; message: string }> = [];
    for (const item of selected) {
      if (input.signal?.aborted) throw new DOMException("反馈生成已取消", "AbortError");
      const student = item.studentId ? contextByStudent.get(item.studentId) ?? null : null;
      const itemName = student?.name ?? "班级公共反馈";
      try {
        const bundle = assessmentBundleOverrides.get(item.id)
          ?? FeedbackEvidenceBundleSchema.parse(parseJson(item.evidenceSnapshot, {}));
        const preference = student?.communicationPreference;
        const generated = await generateFeedbackPlanComposition({
          studentName: student?.name ?? "班级家长",
          planType: plan.type as FeedbackPlanCreateInput["type"],
          evidenceBundle: bundle,
          style: preference?.terminology === "professional" ? "professional" : "gentle",
          length: preference?.length === "short" ? "short" : "standard",
          draftClient,
          draftModel,
          reviewClient,
          reviewModel,
          existingTaskIds: activeTaskIds(item.tasks),
          signal: input.signal,
        });
        const otherStudentNames = plan.items.flatMap((entry) => entry.student?.name && entry.student.id !== item.studentId ? [entry.student.name] : []);
        const audit = createAuditSnapshot(
          generated.composition,
          bundle,
          activeTaskIds(item.tasks),
          { studentName: student?.name ?? undefined, otherStudentNames },
          { requireAllEvidenceInText: true, enforceParentAudience: true },
        );
        const generation = await recordSuccessfulGeneration({
          taskType: "feedback",
          stage: "plan-review",
          semesterId: plan.semesterId,
          classId: plan.classId,
          sessionId: plan.sessionId,
          studentId: item.studentId,
          feedbackPlanItemId: item.id,
          sourceRefs: item.studentId ? [{ type: "student", id: item.studentId }] : [],
          promptVersion: "feedback-plan-v2",
          modelRole: "feedbackReview",
          inputRevision: String(plan.planRevision),
          inputSnapshot: { evidenceBundle: bundle, draftComposition: generated.draftComposition },
          outputSnapshot: { composition: generated.composition, audit },
          finalText: generated.composition.draftFeedback,
        }, db);
        const writeResult = await db.feedbackPlanItem.updateMany({
          where: { id: item.id, status: "generating" },
          data: {
            evidenceSnapshot: json(bundle),
            compositionSnapshot: json(generated.composition),
            auditSnapshot: json(audit),
            finalText: generated.composition.draftFeedback,
            finalTextHash: sha256(generated.composition.draftFeedback),
            selectedGenerationId: generation.id,
            status: "needs_review",
            reviewMode: "model",
            itemRevision: { increment: 1 },
          },
        });
        if (writeResult.count !== 1) {
          throw new ApiError("反馈证据或偏好在生成期间发生变化，请刷新后重新生成", 409, "conflict", false);
        }
        const updated = await db.feedbackPlanItem.findUnique({ where: { id: item.id } });
        if (!updated) throw new Error("生成后的反馈条目无法读取");
        results.push(updated);
        await input.onProgress?.({ type: "item", itemId: updated.id, status: updated.status, message: itemName });
      } catch (error) {
        if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
        const original = originalStates.get(item.id);
        if (original) {
          await db.feedbackPlanItem.updateMany({
            where: { id: item.id, status: "generating" },
            data: { status: original.status, approvedAt: original.approvedAt, exportedAt: original.exportedAt },
          });
        }
        const message = error instanceof ApiError
          ? error.message
          : error instanceof SyntaxError
            ? "模型返回的结构不完整，本条已保留原版本，可单独重试"
            : "本条反馈生成失败，已保留原版本，可单独重试";
        failures.push({ itemId: item.id, name: itemName, message });
        await input.onProgress?.({ type: "item", itemId: item.id, status: "error", message: itemName, error: message });
      }
    }
    const currentItems = await db.feedbackPlanItem.findMany({ where: { planId: plan.id }, select: { status: true } });
    await db.feedbackPlan.update({ where: { id: plan.id }, data: { status: derivePlanStatus(currentItems), planRevision: { increment: 1 } } });
    await input.onProgress?.({ type: "status", message: failures.length ? `生成完成：成功 ${results.length} 条，失败 ${failures.length} 条` : `生成完成：${results.length} 条` });
    return results;
  } catch (error) {
    await db.$transaction(async (tx) => {
      for (const item of selected) {
        const original = originalStates.get(item.id);
        if (!original) continue;
        await tx.feedbackPlanItem.updateMany({
          where: { id: item.id, status: "generating" },
          data: { status: original.status, approvedAt: original.approvedAt, exportedAt: original.exportedAt },
        });
      }
      const currentItems = await tx.feedbackPlanItem.findMany({ where: { planId: plan.id }, select: { status: true } });
      await tx.feedbackPlan.update({
        where: { id: plan.id },
        data: { status: derivePlanStatus(currentItems) },
      });
    }).catch(() => undefined);
    throw error;
  }
}

export async function createPreferenceCandidate(input: {
  studentId: string;
  sourceType: "communication" | "teacher";
  sourceId?: string;
  preference: CommunicationPreference;
  evidence?: { source?: "teacher_manual"; signals?: string[] };
}, db: PrismaClient = prisma) {
  const preference = CommunicationPreferenceSchema.parse(input.preference);
  const evidence = {
    ...(input.evidence?.source === "teacher_manual" ? { source: "teacher_manual" as const } : {}),
    ...(input.evidence?.signals?.length ? { signals: input.evidence.signals.filter((signal) => typeof signal === "string").map((signal) => signal.slice(0, 100)).slice(0, 10) } : {}),
  };
  return db.communicationPreferenceCandidate.create({
    data: {
      studentId: input.studentId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      preferenceSnapshot: json(preference),
      evidenceSnapshot: json(evidence),
    },
  });
}

export async function resolvePreferenceCandidate(id: string, decision: "confirmed" | "rejected", db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const candidate = await tx.communicationPreferenceCandidate.findUnique({ where: { id } });
    if (!candidate) throw new ApiError("沟通偏好候选不存在", 404, "not_found", false);
    if (candidate.status !== "pending") throw new ApiError("沟通偏好候选已经处理，不能重复提交", 409, "conflict", false);
    const updated = await tx.communicationPreferenceCandidate.update({ where: { id }, data: { status: decision, reviewedAt: new Date() } });
    if (decision === "rejected") return updated;
    const preference = CommunicationPreferenceSchema.parse(parseJson(candidate.preferenceSnapshot, {}));
    await tx.communicationPreferenceCandidate.updateMany({
      where: { studentId: candidate.studentId, status: "confirmed", id: { not: id } },
      data: { status: "superseded" },
    });
    await tx.communicationPreference.upsert({
      where: { studentId: candidate.studentId },
      create: { studentId: candidate.studentId, preferenceSnapshot: json(preference), sourceCandidateId: id, confirmedAt: new Date() },
      update: { preferenceSnapshot: json(preference), sourceCandidateId: id, confirmedAt: new Date() },
    });
    return updated;
  });
}
