import { ApiError } from "@/lib/api-errors";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";
import type { FeedbackGenerationApproach } from "@/lib/feedback-generation-approach";
import type { LessonFeedbackMaterial, StudentAssessmentEvidence } from "@/lib/feedback-materials";
import type { FeedbackGenerationPreferences, FeedbackPlanInputSnapshot } from "@/lib/feedback-plan";
import {
  CommunicationPreferenceSchema,
  FeedbackEvidenceBundleSchema,
  FeedbackHistorySnapshotSchema, FeedbackPlanCreateSchema, FeedbackPlanInputSnapshotSchema,
  FeedbackPlanInputSnapshotV2Schema,
  sanitizeFeedbackEvidenceBundle,
  type FeedbackEvidenceBundle,
  type FeedbackHistorySnapshot,
  type FeedbackPlanAssessmentEvidenceInput,
  type FeedbackPlanCreateInput,
  type FeedbackPlanIntakeSourceSummary
} from "@/lib/feedback-plan";
import { buildFeedbackContext, type FeedbackContextStudent } from "@/services/feedback-context-service";
import { sha256 } from "@/services/feedback-plan-audit";
import { FeedbackPlanDb, feedbackPlanDraftFingerprint, normalizedStudentOverrides, parseGenerationConfigSnapshot, parseJson, StoredFeedbackPlanDraft } from "@/services/feedback-plan/model";
import { semesterStudentWhere } from "@/services/student-enrollment-service";


type NormalizedPlanAssessmentEvidence = Record<string, StudentAssessmentEvidence[]>;



export function normalizePlanAssessmentEvidence(input: {
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



export function persistedAssessmentEvidence(snapshot: string): FeedbackEvidenceBundle["assessmentEvidence"] {
  const parsed = FeedbackEvidenceBundleSchema.safeParse(parseJson(snapshot, null));
  return parsed.success ? sanitizeFeedbackEvidenceBundle(parsed.data).assessmentEvidence : [];
}



export function activeTaskIds(tasks: Array<{ id: string; status: string }>) {
  return new Set(tasks.filter((task) => task.status !== "cancelled").map((task) => task.id));
}



export function auditTaskIdsForBundle(
  bundle: FeedbackEvidenceBundle,
  tasks: Array<{ id: string; status: string }>,
) {
  return new Set([
    ...bundle.executionConstraints.existingTaskIds,
    ...activeTaskIds(tasks),
  ]);
}



export function auditIdentityForPlanItem(
  plan: {
    inputSnapshot: string;
    items: Array<{
      id: string;
      studentId: string | null;
      student?: { name: string } | null;
    }>;
  },
  item: { id: string; studentId: string | null; student?: { name: string } | null },
) {
  const snapshot = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(plan.inputSnapshot, null));
  if (snapshot.success && snapshot.data.version === 2) {
    const target = snapshot.data.factSnapshot.items.find((entry) => entry.studentId === item.studentId);
    return {
      studentName: item.studentId
        ? target?.studentName ?? target?.studentNumber ?? item.student?.name
        : undefined,
      otherStudentNames: snapshot.data.factSnapshot.items.flatMap((entry) => (
        entry.studentId && entry.studentId !== item.studentId && entry.studentName ? [entry.studentName] : []
      )),
    };
  }
  return {
    studentName: item.student?.name,
    otherStudentNames: plan.items.flatMap((entry) => (
      entry.id !== item.id && entry.student?.name ? [entry.student.name] : []
    )),
  };
}



export function defaultLessonMaterial(): LessonFeedbackMaterial {
  return LessonFeedbackMaterialSchema.parse({
    version: 1,
    groupFeedbackRaw: "",
    assessmentBriefRaw: "",
    lessonTitle: "",
    classroomContent: [],
    classroomFocus: [],
    classroomExplanation: [],
    homework: [],
    assessmentFocus: [],
    correctionAdvice: [],
    otherNotes: [],
  });
}



function lessonMaterialBackground(material: LessonFeedbackMaterial | undefined) {
  if (!material) return [];
  return [
    material.lessonTitle ? `课程标题：${material.lessonTitle}` : "",
    material.lessonSummary ? `课程摘要：${material.lessonSummary}` : "",
    ...material.classroomContent.map((value) => `课堂内容：${value}`),
    ...material.classroomFocus.map((value) => `课堂重点：${value}`),
    ...material.classroomExplanation.map((value) => `课堂讲解：${value}`),
    ...material.homework.map((value) => `统一课后任务：${value}`),
    ...material.assessmentFocus.map((value) => `测评范围：${value}`),
    ...material.correctionAdvice.map((value) => `统一订正建议：${value}`),
    ...material.otherNotes.map((value) => `课程备注：${value}`),
  ].filter(Boolean).slice(0, 100);
}



function historySnapshot(student: FeedbackContextStudent | null): FeedbackHistorySnapshot | null {
  if (!student) return null;
  const current = student.rawMetrics.current;
  const recent = student.rawMetrics.recent.filter((metric) => metric.sessionId !== current.sessionId).slice(0, 5).map((metric) => ({
    metricId: metric.metricId,
    sessionId: metric.sessionId,
    date: metric.date,
    semesterNumber: metric.semesterNumber,
    scoreA: metric.scoreA,
    scoreB: metric.scoreB,
    scoreC: metric.scoreC,
    scoreD: metric.scoreD,
  }));
  const currentMetric = current.metricId || [current.scoreA, current.scoreB, current.scoreC, current.scoreD].some((value) => value !== null)
    ? {
      metricId: current.metricId,
      sessionId: current.sessionId,
      date: current.date,
      semesterNumber: current.semesterNumber,
      scoreA: current.scoreA,
      scoreB: current.scoreB,
      scoreC: current.scoreC,
      scoreD: current.scoreD,
      present: current.present,
    }
    : null;
  const previous = recent.find((metric) => metric.sessionId !== currentMetric?.sessionId) ?? null;
  return FeedbackHistorySnapshotSchema.parse({
    version: 1,
    current: currentMetric,
    previous,
    recent,
    semesterAverage: {
      A: student.rawMetrics.performanceBaseline.semesterAverageA,
      B: student.rawMetrics.performanceBaseline.semesterAverageB,
      C: student.rawMetrics.performanceBaseline.semesterAverageC,
      D: student.rawMetrics.performanceBaseline.semesterAverageD,
    },
  });
}



function planAnchorSession(input: FeedbackPlanCreateInput) {
  return input.type === "stage_trend" || input.type === "course_end"
    ? input.rangeEndSessionId ?? input.sessionId ?? input.rangeStartSessionId
    : input.sessionId ?? input.rangeEndSessionId ?? input.rangeStartSessionId;
}



export async function resolveSession(db: FeedbackPlanDb, value: string | undefined) {
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



export async function assertPlanScope(db: FeedbackPlanDb, input: FeedbackPlanCreateInput) {
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



export function evidenceFromStudent(input: {
  planType: FeedbackPlanCreateInput["type"];
  student: FeedbackContextStudent | null;
  sourceFingerprint: string;
  existingTaskIds?: string[];
  assessmentEvidence?: StudentAssessmentEvidence[];
  preservedAssessmentEvidence?: FeedbackEvidenceBundle["assessmentEvidence"];
  lessonMaterial?: LessonFeedbackMaterial;
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
    content: `${item.occurredAt || item.date} 与${item.target}：${item.summary}`,
    sourceRefs: [{ type: "communication", id: item.id!, label: "近期家校沟通" }],
    occurredAt: item.occurredAt || item.date,
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
    version: 2,
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
    teachingBackground: lessonMaterialBackground(input.lessonMaterial),
    historySnapshot: historySnapshot(student),
  });
}



export function evidenceFromClassContext(input: {
  planType: FeedbackPlanCreateInput["type"];
  students: FeedbackContextStudent[];
  sessionId?: string;
  sourceFingerprint: string;
  existingTaskIds?: string[];
  lessonMaterial?: LessonFeedbackMaterial;
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
    version: 2,
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
    teachingBackground: lessonMaterialBackground(input.lessonMaterial),
    historySnapshot: null,
  });
}



export async function findContextForPlan(db: FeedbackPlanDb, input: FeedbackPlanCreateInput) {
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



export function candidateStudentIds(input: FeedbackPlanCreateInput, context: Awaited<ReturnType<typeof buildFeedbackContext>> | null) {
  if (input.type === "class_update") return [null];
  if (input.studentIds) return [...new Set(input.studentIds)];
  return context?.students
    .filter((student) => input.type === "event_micro"
      ? student.feedbackRecommendationReasons.length > 0
      : student.rawMetrics.recent.length > 0 || student.rawMetrics.current.events.length > 0)
    .map((student) => student.id) ?? [];
}



function numberFromSnapshot(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}



export async function feedbackPlanIntakeSources(
  db: FeedbackPlanDb,
  intakeRunIds: string[] | undefined,
  expectedSessionCode: string | undefined,
): Promise<FeedbackPlanIntakeSourceSummary[]> {
  const ids = [...new Set(intakeRunIds ?? [])];
  if (!ids.length) return [];
  const runs = await db.feedbackIntakeRun.findMany({ where: { id: { in: ids } } });
  if (runs.length !== ids.length) throw new ApiError("反馈计划引用的材料运行不存在", 404, "not_found", false);
  const byId = new Map(runs.map((run) => [run.id, run]));
  return ids.map((id) => {
    const run = byId.get(id)!;
    if (run.status !== "applied") throw new ApiError("反馈计划只能使用已经确认的材料运行", 409, "conflict", false);
    if (expectedSessionCode && run.sessionCode !== expectedSessionCode) {
      throw new ApiError("反馈计划材料运行与目标课次不一致", 409, "conflict", false);
    }
    const applied = parseJson<Record<string, unknown>>(run.appliedSummary, {});
    const scopeConfirmation = applied.scopeConfirmation && typeof applied.scopeConfirmation === "object"
      ? applied.scopeConfirmation as Record<string, unknown>
      : null;
    const manifest = parseJson<Array<Record<string, unknown>>>(run.sourceManifest, []);
    const issues = parseJson<unknown[]>(run.issues, []);
    const decisions = Array.isArray(applied.decisions)
      ? applied.decisions.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const decision = value as Record<string, unknown>;
        if (typeof decision.action !== "string" || !decision.action.trim()) return [];
        return [{
          action: decision.action.slice(0, 80),
          ...(typeof decision.sourceName === "string" && decision.sourceName.trim()
            ? { sourceName: decision.sourceName.slice(0, 500) }
            : {}),
          ...(typeof decision.text === "string" && decision.text.trim()
            ? { detail: decision.text.slice(0, 500) }
            : {}),
        }];
      })
      : [];
    return {
      intakeRunId: run.id,
      sessionCode: run.sessionCode,
      status: run.status,
      confirmedAt: typeof scopeConfirmation?.confirmedAt === "string" ? scopeConfirmation.confirmedAt : null,
      sourceCount: numberFromSnapshot(applied.sourceCount) || manifest.length,
      recognizedCount: numberFromSnapshot(applied.recognizedCount),
      ignoredCount: numberFromSnapshot(applied.ignoredCount),
      issueCount: numberFromSnapshot(applied.issueCount) || issues.length,
      resolvedDecisionCount: decisions.length,
      resolutions: decisions,
      sources: manifest.map((source) => ({
        name: typeof source.name === "string" ? source.name : "未命名材料",
        kind: typeof source.kind === "string" ? source.kind : "unknown",
        source: typeof source.source === "string" ? source.source : "upload",
      })),
    };
  });
}



export function feedbackPlanSnapshotV2(plan: StoredFeedbackPlanDraft) {
  const parsed = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(plan.inputSnapshot, null));
  if (parsed.success && parsed.data.version === 2) return parsed.data;
  const legacy = parsed.success ? parsed.data : null;
  const factItems = plan.items.flatMap((item) => {
    const evidence = FeedbackEvidenceBundleSchema.safeParse(parseJson(item.evidenceSnapshot, null));
    if (!evidence.success) return [];
    const communicationPreference = item.student?.communicationPreference
      ? CommunicationPreferenceSchema.safeParse(parseJson(item.student.communicationPreference.preferenceSnapshot, null))
      : null;
    return [{
      studentId: item.studentId,
      ...(item.student ? { studentName: item.student.name, studentNumber: item.student.studentId } : {}),
      ...(communicationPreference?.success ? { communicationPreference: communicationPreference.data } : {}),
      ...(plan.rangeEndSession?.date || plan.session?.date
        ? { referenceDate: plan.rangeEndSession?.date ?? plan.session?.date }
        : {}),
      evidence: evidence.data,
    }];
  });
  const studentOverrides = plan.items.flatMap((item) => {
    if (!item.studentId) return [];
    const generationConfig = parseGenerationConfigSnapshot(item.generationConfigSnapshot);
    return generationConfig ? [{ studentId: item.studentId, generationConfig }] : [];
  });
  return FeedbackPlanInputSnapshotV2Schema.parse({
    version: 2,
    semesterId: legacy?.semesterId ?? plan.semesterId,
    classId: legacy?.classId ?? plan.classId,
    sessionId: legacy?.sessionId ?? plan.sessionId ?? undefined,
    rangeStartSessionId: legacy?.rangeStartSessionId ?? plan.rangeStartSessionId ?? undefined,
    rangeEndSessionId: legacy?.rangeEndSessionId ?? plan.rangeEndSessionId ?? undefined,
    sessionCode: legacy?.sessionCode ?? plan.session?.code,
    sourceFingerprint: legacy?.sourceFingerprint ?? plan.inputFingerprint,
    lessonMaterial: legacy?.lessonMaterial ?? defaultLessonMaterial(),
    generationPreferences: legacy?.generationPreferences,
    selectedStudentIds: plan.items.flatMap((item) => item.studentId ? [item.studentId] : []),
    studentOverrides,
    factSnapshot: { capturedAt: plan.createdAt.toISOString(), items: factItems },
    intakeSources: [],
  });
}

/** Resolves confirmed facts into the immutable input used when a plan is created. */
export async function buildFeedbackPlanFrozenInput(
  input: ReturnType<typeof FeedbackPlanCreateSchema.parse> & {
    generationPreferences: FeedbackGenerationPreferences;
    generationApproach: FeedbackGenerationApproach;
    lessonMaterial: LessonFeedbackMaterial;
  },
  rangeStartSessionId: string | undefined,
  rangeEndSessionId: string | undefined,
  db: FeedbackPlanDb,
) {
  const { generationPreferences, lessonMaterial } = input;
  // 先确定真实范围，再组装证据；否则阶段/结课计划会错误地复用当前课次的五次近期上下文。
  const context = await findContextForPlan(db, {
    ...input,
    rangeStartSessionId,
    rangeEndSessionId,
    studentIds: undefined,
  });
  const selectedIds = candidateStudentIds(input, context);
  if (!selectedIds.length) throw new ApiError("没有可加入反馈计划的学生", 400, "invalid_request", false);
  const contextStudentIds = context?.students.map((student) => student.id) ?? [];
  const missingSelectedStudent = selectedIds.find((studentId) => studentId !== null && !contextStudentIds.includes(studentId));
  if (missingSelectedStudent) throw new ApiError("反馈计划包含不属于当前课次上下文的学生", 400, "invalid_request", false);
  const assessmentByStudent = normalizePlanAssessmentEvidence({
    assessmentEvidence: input.assessmentEvidence,
    sessionCode: context?.session.code ?? "",
    allowedStudentIds: contextStudentIds,
  });
  const contextByStudent = new Map(context?.students.map((student) => [student.id, student]) ?? []);
  const studentOverridesById = normalizedStudentOverrides({
    overrides: input.studentOverrides,
    selectedIds,
    contextStudentIds: new Set(contextStudentIds),
  });
  const existingTasks = await db.teacherTask.findMany({
    where: {
      classId: input.classId,
      status: "pending",
      ...(input.type === "class_update"
        ? {}
        : { studentId: { in: contextStudentIds } }),
    },
    select: { id: true, studentId: true },
  });
  const taskIdsByStudent = new Map<string | null, string[]>();
  for (const task of existingTasks) {
    const key = task.studentId ?? null;
    taskIdsByStudent.set(key, [...(taskIdsByStudent.get(key) ?? []), task.id]);
  }

  const sourceFingerprint = sha256(JSON.stringify({
    input: {
      type: input.type,
      outputRequirement: input.outputRequirement,
      generationApproach: input.generationApproach,
      semesterId: input.semesterId,
      classId: input.classId,
      sessionId: input.sessionId,
      rangeStartSessionId,
      rangeEndSessionId,
      studentIds: selectedIds,
      generationPreferences,
    },
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
    lessonMaterial,
    studentOverrides: Object.fromEntries(studentOverridesById),
  }));

  const factStudentIds: Array<string | null> = input.type === "class_update" ? [null] : contextStudentIds;
  const frozenFacts = factStudentIds.map((studentId) => {
    const student = studentId ? contextByStudent.get(studentId) ?? null : null;
    const evidence = input.type === "class_update"
      ? evidenceFromClassContext({
        planType: input.type,
        students: context?.students ?? [],
        sessionId: input.sessionId ?? rangeEndSessionId,
        sourceFingerprint,
        existingTaskIds: taskIdsByStudent.get(null),
        lessonMaterial,
      })
      : evidenceFromStudent({
        planType: input.type,
        student,
        sourceFingerprint,
        existingTaskIds: taskIdsByStudent.get(studentId),
        assessmentEvidence: studentId ? assessmentByStudent[studentId] : undefined,
        lessonMaterial,
      });
    return {
      studentId,
      ...(student ? {
        studentName: student.name,
        studentNumber: student.studentId,
        communicationPreference: student.communicationPreference ?? null,
      } : {}),
      ...(context?.session.date ? { referenceDate: context.session.date } : {}),
      evidence,
    };
  });
  const intakeSources = await feedbackPlanIntakeSources(db, input.intakeRunIds, context?.session.code);
  const inputSnapshot: FeedbackPlanInputSnapshot = {
    version: 2,
    ...(input.requestKey ? { draftRequestKey: input.requestKey } : {}),
    semesterId: input.semesterId,
    classId: input.classId,
    sessionId: input.sessionId,
    rangeStartSessionId,
    rangeEndSessionId,
    sessionCode: context?.session.code,
    sourceFingerprint,
    lessonMaterial,
    generationPreferences,
    selectedStudentIds: selectedIds.filter((studentId): studentId is string => Boolean(studentId)),
    studentOverrides: [...studentOverridesById.entries()].map(([studentId, generationConfig]) => ({ studentId, generationConfig })),
    factSnapshot: {
      capturedAt: new Date().toISOString(),
      items: frozenFacts,
    },
    intakeSources,
  };
  const inputFingerprint = feedbackPlanDraftFingerprint({
    snapshot: inputSnapshot,
    type: input.type,
    outputRequirement: input.outputRequirement,
    generationApproach: input.generationApproach,
    generationPreferences,
    selectedStudentIds: selectedIds,
    studentOverrides: studentOverridesById,
  });

  const frozenFactsByStudent = new Map(frozenFacts.map((fact) => [fact.studentId, fact.evidence]));

  return { inputSnapshot, inputFingerprint, selectedIds, studentOverridesById, frozenFactsByStudent };
}
