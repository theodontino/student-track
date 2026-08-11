import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { publicStudentLabels } from "@/lib/attention-labels";
import {
  FEEDBACK_COMMUNICATION_CATEGORY_LABELS,
  isUsefulLegacyFeedbackCommunication,
  parseFeedbackCommunicationSummary,
} from "@/lib/feedback-communication";
import {
  extractFeedbackDateRange,
  feedbackDateRangeLabel,
  relativeFeedbackDateLabel,
} from "@/lib/feedback-time";
import { safeFeedbackCommunicationTarget } from "@/lib/feedback-text-safety";
import { CommunicationPreferenceSchema, type CommunicationPreference } from "@/lib/feedback-plan";
import { semesterStudentWhere } from "@/services/student-enrollment-service";

const RECENT_SESSION_LIMIT = 5;
const COMMUNICATION_PREVIEW_LIMIT = 3;
const COMMUNICATION_PROMPT_LIMIT = 8;
const EVENT_LIMIT = 3;

export interface FeedbackContextPreview {
  today: string[];
  trend: string;
  communications: string[];
  labels: string[];
}

export interface StudentRawMetrics {
  current: {
    metricId?: string;
    sessionId: string;
    date: string;
    semesterNumber: number;
    scoreA: number | null;
    scoreB: number | null;
    scoreC: number | null;
    scoreD: number | null;
    present: boolean | null;
    events: string[];
    eventRefs?: Array<{ id: string; description: string; sessionId: string | null; type?: string }>;
  };
  recentEventRefs?: Array<{ id: string; description: string; sessionId: string | null; type?: string; date?: string }>;
  recent: Array<{
    metricId?: string;
    sessionId?: string | null;
    date: string;
    semesterNumber: number;
    scoreA: number;
    scoreB: number;
    scoreC: number;
    scoreD: number;
  }>;
  communications: Array<{
    id?: string;
    sessionId?: string | null;
    date: string;
    occurredAt?: string;
    target: string;
    summary: string;
  }>;
  performanceBaseline: {
    semesterValidCount: number;
    recentValidCount: number;
    semesterAverageA: number | null;
    semesterAverageB: number | null;
    semesterAverageC: number | null;
    semesterAverageD: number | null;
    recentAverageA: number | null;
    personalDifference: number | null;
    classComparisonCount: number;
    classAverageDifference: number | null;
  };
}

export interface FeedbackContextStudent {
  id: string;
  name: string;
  studentId: string;
  labels: string[];
  promptContext: string;
  preview: FeedbackContextPreview;
  rawMetrics: StudentRawMetrics;
  communicationPreference?: CommunicationPreference;
  feedbackRecommendationReasons: string[];
}

export interface FeedbackContextResult {
  session: {
    id: string;
    code: string;
    date: string;
    semesterId: string;
    semesterNumber: number;
    classId: string;
  };
  className: string;
  total: number;
  students: FeedbackContextStudent[];
}

function scoreText(value: number | null | undefined) {
  return value === null || value === undefined ? "无记录" : `${value}分`;
}

function attendanceText(value: boolean | undefined) {
  if (value === undefined) return "无记录";
  return value ? "到课" : "缺勤";
}

function shortSummary(value: string, limit = 120) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function average(values: number[]) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function rounded(value: number | null, digits = 2) {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function groupByStudent<T extends { studentId: string }>(items: T[]) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const list = grouped.get(item.studentId) ?? [];
    list.push(item);
    grouped.set(item.studentId, list);
  }
  return grouped;
}

function feedbackCommunicationDate(input: {
  summary: string;
  occurredAt?: string | null;
  createdAt: Date;
  session: { date: string } | null;
}) {
  const parsed = parseFeedbackCommunicationSummary(input.summary);
  const occurredAt = input.occurredAt?.trim() || parsed.occurredAt;
  const range = extractFeedbackDateRange(occurredAt);
  if (range) return feedbackDateRangeLabel(range);
  if (input.session?.date) return input.session.date;
  return input.createdAt.toISOString().slice(0, 10);
}

function feedbackCommunicationSortDate(input: {
  feedbackDate: string;
  session: { date: string } | null;
}) {
  return extractFeedbackDateRange(input.feedbackDate)?.end ?? input.session?.date ?? "";
}

function rankFeedbackCommunications<T extends {
  summary: string;
  occurredAt?: string | null;
  createdAt: Date;
  session: { date: string } | null;
}>(items: T[]) {
  const priority = { high: 2, medium: 1, low: 0 };
  return items
    .filter((item) => isUsefulLegacyFeedbackCommunication(item.summary))
    .map((item) => {
      const parsed = parseFeedbackCommunicationSummary(item.summary);
      const feedbackDate = feedbackCommunicationDate(item);
      return {
        ...item,
        feedbackSummary: parsed.summary,
        feedbackDecision: parsed.decision,
        feedbackDate,
        feedbackSortDate: feedbackCommunicationSortDate({ feedbackDate, session: item.session }),
      };
    })
    .sort((left, right) => (
      right.feedbackSortDate.localeCompare(left.feedbackSortDate)
      || (priority[right.feedbackDecision?.priority ?? "medium"] - priority[left.feedbackDecision?.priority ?? "medium"])
      || right.createdAt.getTime() - left.createdAt.getTime()
    ));
}

function feedbackCommunicationPromptLine(input: {
  target: string;
  feedbackSummary: string;
  feedbackDate: string;
  referenceDate?: string;
  feedbackDecision: ReturnType<typeof parseFeedbackCommunicationSummary>["decision"];
}) {
  const decision = input.feedbackDecision;
  const context = decision
    ? `｜${decision.priority === "high" ? "高" : "中"}优先级｜${FEEDBACK_COMMUNICATION_CATEGORY_LABELS[decision.category]}`
    : "";
  const dateLabel = input.referenceDate
    ? relativeFeedbackDateLabel(input.referenceDate, input.feedbackDate)
    : input.feedbackDate;
  return `${dateLabel}${context} 与${safeFeedbackCommunicationTarget(input.target)}：${shortSummary(input.feedbackSummary)}`;
}

function buildTodayPreview(input: {
  metric?: { scoreA: number; scoreB: number; scoreC: number; scoreD: number };
  attendance?: boolean;
  events: string[];
}) {
  const lines = [
    `学习&测验 ${scoreText(input.metric?.scoreA)}`,
    `精神&纪律 ${scoreText(input.metric?.scoreB)}`,
    `课后任务 ${scoreText(input.metric?.scoreC)}`,
    `考勤 ${scoreText(input.metric?.scoreD)} / ${attendanceText(input.attendance)}`,
  ];
  if (input.events.length > 0) lines.push(`关键事件：${input.events.join("；")}`);
  return lines;
}

function buildTrendPreview(metrics: Array<{
  scoreA: number;
  scoreB: number;
  scoreC: number;
  scoreD: number;
  session: { code: string; date: string; semesterNumber: number } | null;
}>, referenceDate?: string) {
  if (metrics.length === 0) return "暂无近期评分趋势";

  const chronological = [...metrics].reverse();
  return chronological.map((metric) => {
    const label = metric.session
      ? `${referenceDate ? relativeFeedbackDateLabel(referenceDate, metric.session.date) : metric.session.date} 第${metric.session.semesterNumber}次`
      : "未知课次";
    return `${label}: A${metric.scoreA}/B${metric.scoreB}/C${metric.scoreC}/D${metric.scoreD}`;
  }).join("；");
}

function buildPromptContext(input: {
  studentName: string;
  sessionDate: string;
  semesterNumber: number;
  labels: string[];
  today: string[];
  trend: string;
  communications: string[];
  baseline: StudentRawMetrics["performanceBaseline"];
}) {
  const labels = input.labels.length > 0 ? input.labels.join("、") : "无";
  const communications = input.communications.length > 0 ? input.communications.join("；") : "无";
  const baseline = buildBaselineText(input.baseline);
  return [
    `${input.studentName}，本次目标课次作为“今天”的时间锚点，是第${input.semesterNumber}次课。`,
    `学生标签：${labels}`,
    `今日表现：${input.today.join("；")}`,
    `近期趋势：${input.trend}`,
    `学期对照：${baseline}`,
    `近期家校沟通：${communications}`,
  ].join("\n");
}

function signedDifference(value: number) {
  if (Math.abs(value) < 0.05) return "基本持平";
  return value > 0 ? `高${value.toFixed(1)}分` : `低${Math.abs(value).toFixed(1)}分`;
}

function buildBaselineText(baseline: StudentRawMetrics["performanceBaseline"]) {
  if (baseline.recentValidCount < 2 || baseline.semesterValidCount < 3) {
    return `个人本学期有效评价${baseline.semesterValidCount}次，暂不足以判断最近两次相对个人常态的变化`;
  }
  const personal = baseline.personalDifference === null
    ? "个人常态暂无可比数据"
    : `最近两次A均分${baseline.recentAverageA?.toFixed(1)}，较个人本学期A均分${baseline.semesterAverageA?.toFixed(1)}${signedDifference(baseline.personalDifference)}`;
  const classroom = baseline.classAverageDifference === null
    ? "对应课次班级有效评价不足，暂不做同期班均对照"
    : `在${baseline.classComparisonCount}次可比课次中平均较同期班级A均值${signedDifference(baseline.classAverageDifference)}`;
  return `${personal}；${classroom}`;
}

/**
 * Builds deterministic feedback context from existing Student Track records.
 * LLM generation may consume the compact promptContext, while UI can render preview.
 */
export async function buildFeedbackContext(
  prisma: PrismaClient | Prisma.TransactionClient,
  sessionCode: string,
  options?: { sessionIds?: string[]; includeStudentIds?: string[] },
): Promise<FeedbackContextResult> {
  const session = await prisma.classSession.findUnique({
    where: { code: sessionCode },
    include: { class: { select: { name: true, code: true } } },
  });
  if (!session) throw new Error("课次不存在");
  if (!session.classId) throw new Error("该课次未关联班级");

  const className = session.class?.name ?? session.class?.code ?? "";
  if (!className) throw new Error("该课次未关联班级");

  const includeStudentIds = [...new Set(options?.includeStudentIds ?? [])];
  const historicalSessionEvidence = [
    { sessionMetrics: { some: { sessionId: session.id } } },
    { attendances: { some: { sessionId: session.id } } },
    { events: { some: { sessionId: session.id } } },
    { communications: { some: { sessionId: session.id } } },
  ];
  const students = await prisma.student.findMany({
    where: includeStudentIds.length
      ? {
          OR: [
            semesterStudentWhere({ semesterId: session.semesterId, classId: session.classId, activeOnly: true }),
            semesterStudentWhere({ semesterId: session.semesterId, classId: session.classId, studentIds: includeStudentIds }),
            ...historicalSessionEvidence,
          ],
        }
      : {
          OR: [
            semesterStudentWhere({ semesterId: session.semesterId, classId: session.classId, activeOnly: true }),
            ...historicalSessionEvidence,
          ],
        },
    select: {
      id: true,
      name: true,
      studentId: true,
      studentLabels: { include: { label: { select: { name: true } } } },
      communicationPreference: { select: { preferenceSnapshot: true } },
    },
    orderBy: { studentId: "asc" },
  });
  if (students.length === 0) throw new Error("该班级无学生");

  const studentIds = students.map((student) => student.id);
  const recentSessions = await prisma.classSession.findMany({
    where: options?.sessionIds?.length ? {
      id: { in: [...new Set(options.sessionIds)] },
      classId: session.classId,
      semesterId: session.semesterId,
    } : {
      classId: session.classId,
      semesterId: session.semesterId,
      OR: [
        { date: { lt: session.date } },
        { date: session.date, semesterNumber: { lte: session.semesterNumber } },
      ],
    },
    select: { id: true, code: true, date: true, semesterNumber: true, createdAt: true },
    orderBy: [{ date: "desc" }, { semesterNumber: "desc" }, { createdAt: "desc" }],
    ...(options?.sessionIds?.length ? {} : { take: RECENT_SESSION_LIMIT }),
  });
  const recentSessionIds = recentSessions.map((item) => item.id);

  const [currentMetrics, currentAttendances, currentEvents, recentMetrics, recentEvents, communications, semesterMetrics] =
    await Promise.all([
      prisma.sessionMetric.findMany({ where: { sessionId: session.id, studentId: { in: studentIds } } }),
      prisma.attendance.findMany({ where: { sessionId: session.id, studentId: { in: studentIds } } }),
      prisma.event.findMany({
        where: { sessionId: session.id, studentId: { in: studentIds } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.sessionMetric.findMany({
        where: { studentId: { in: studentIds }, sessionId: { in: recentSessionIds } },
        include: { session: { select: { code: true, date: true, semesterNumber: true } } },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      }),
      prisma.event.findMany({
        where: { studentId: { in: studentIds }, sessionId: { in: recentSessionIds } },
        include: { session: { select: { code: true, date: true, semesterNumber: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.communication.findMany({
        where: {
          studentId: { in: studentIds },
          // A feedback context is tied to the target session's class and
          // semester. Do not let a student's communication from another term
          // leak into the current draft merely because the profile is stable.
          ...(options?.sessionIds?.length
            ? { sessionId: { in: recentSessionIds } }
            : {
                session: {
                  semesterId: session.semesterId,
                  classId: session.classId,
                  OR: [
                    { date: { lt: session.date } },
                    { date: session.date, semesterNumber: { lte: session.semesterNumber } },
                  ],
                },
              }),
        },
        include: { session: { select: { code: true, date: true, semesterNumber: true } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.sessionMetric.findMany({
        where: {
          studentId: { in: studentIds },
          sessionId: options?.sessionIds?.length ? { in: recentSessionIds } : undefined,
          ...(options?.sessionIds?.length ? {} : { session: {
            semesterId: session.semesterId,
            classId: session.classId,
            OR: [
              { date: { lt: session.date } },
              { date: session.date, semesterNumber: { lte: session.semesterNumber } },
            ],
          } }),
        },
        select: {
          studentId: true,
          sessionId: true,
          scoreA: true,
          scoreB: true,
          scoreC: true,
          scoreD: true,
          session: { select: { date: true, semesterNumber: true } },
        },
        orderBy: [
          { session: { date: "desc" } },
          { session: { semesterNumber: "desc" } },
          { createdAt: "desc" },
        ],
      }),
    ]);

  const currentMetricMap = new Map(currentMetrics.map((metric) => [metric.studentId, metric]));
  const attendanceMap = new Map(currentAttendances.map((attendance) => [attendance.studentId, attendance.present]));
  const currentEventsByStudent = groupByStudent(currentEvents);
  const recentMetricsByStudent = groupByStudent(recentMetrics);
  const recentEventsByStudent = groupByStudent(recentEvents);
  const communicationsAtTarget = communications.filter((communication) => {
    const parsed = parseFeedbackCommunicationSummary(communication.summary);
    const range = extractFeedbackDateRange(communication.occurredAt || parsed.occurredAt);
    // sessionId is lineage, not proof that the conversation happened on the
    // lesson date. A range ending after the target lesson is future evidence.
    return !range || range.end <= session.date;
  });
  const communicationsByStudent = groupByStudent(communicationsAtTarget);
  const semesterMetricsByStudent = groupByStudent(semesterMetrics);
  const semesterMetricsBySession = new Map<string, typeof semesterMetrics>();
  for (const metric of semesterMetrics) {
    if (!metric.sessionId) continue;
    const list = semesterMetricsBySession.get(metric.sessionId) ?? [];
    list.push(metric);
    semesterMetricsBySession.set(metric.sessionId, list);
  }

  const contextStudents = students.map((student): FeedbackContextStudent => {
    const labels = publicStudentLabels(student.studentLabels.map((item) => item.label.name));
    const currentEventTexts = (currentEventsByStudent.get(student.id) ?? []).map((event) => event.description);
    const today = buildTodayPreview({
      metric: currentMetricMap.get(student.id),
      attendance: attendanceMap.get(student.id),
      events: currentEventTexts,
    });

    const trend = buildTrendPreview(recentMetricsByStudent.get(student.id) ?? []);
    const promptTrend = buildTrendPreview(recentMetricsByStudent.get(student.id) ?? [], session.date);
    const feedbackCommunications = rankFeedbackCommunications(communicationsByStudent.get(student.id) ?? []);
    const promptCommunicationLines = feedbackCommunications
      .slice(0, COMMUNICATION_PROMPT_LIMIT)
      .map((communication) => feedbackCommunicationPromptLine({
        ...communication,
        target: communication.target,
        feedbackSummary: communication.feedbackSummary,
        feedbackDate: communication.feedbackDate,
        feedbackDecision: communication.feedbackDecision,
        referenceDate: session.date,
      }));
    const communicationLines = feedbackCommunications
      .slice(0, COMMUNICATION_PREVIEW_LIMIT)
      .map((communication) => (
        `${communication.feedbackDate} 与${communication.target}：${shortSummary(communication.feedbackSummary)}`
      ));
    const recentEventLines = (recentEventsByStudent.get(student.id) ?? [])
      .filter((event) => event.sessionId !== session.id)
      .slice(0, EVENT_LIMIT)
      .map((event) => `${event.session?.date ?? "未知日期"} ${shortSummary(event.description, 80)}`);
    const promptRecentEventLines = (recentEventsByStudent.get(student.id) ?? [])
      .filter((event) => event.sessionId !== session.id)
      .slice(0, EVENT_LIMIT)
      .map((event) => `${event.session?.date ? relativeFeedbackDateLabel(session.date, event.session.date) : "时间未知"} ${shortSummary(event.description, 80)}`);
    const preview: FeedbackContextPreview = {
      today,
      trend: recentEventLines.length > 0 ? `${trend}；近期事件：${recentEventLines.join("；")}` : trend,
      communications: communicationLines,
      labels,
    };
    const studentSemesterMetrics = semesterMetricsByStudent.get(student.id) ?? [];
    const recentStudentMetrics = studentSemesterMetrics.slice(0, 2);
    const semesterAverageA = average(studentSemesterMetrics.map((metric) => metric.scoreA));
    const semesterAverageB = average(studentSemesterMetrics.map((metric) => metric.scoreB));
    const semesterAverageC = average(studentSemesterMetrics.map((metric) => metric.scoreC));
    const semesterAverageD = average(studentSemesterMetrics.map((metric) => metric.scoreD));
    const recentAverageA = average(recentStudentMetrics.map((metric) => metric.scoreA));
    const classDifferences = recentStudentMetrics.flatMap((metric) => {
      if (!metric.sessionId) return [];
      const sameSession = semesterMetricsBySession.get(metric.sessionId) ?? [];
      if (sameSession.length < 3) return [];
      const classAverage = average(sameSession.map((item) => item.scoreA));
      return classAverage === null ? [] : [metric.scoreA - classAverage];
    });
    const baseline: StudentRawMetrics["performanceBaseline"] = {
      semesterValidCount: studentSemesterMetrics.length,
      recentValidCount: recentStudentMetrics.length,
      semesterAverageA: rounded(semesterAverageA),
      semesterAverageB: rounded(semesterAverageB),
      semesterAverageC: rounded(semesterAverageC),
      semesterAverageD: rounded(semesterAverageD),
      recentAverageA: rounded(recentAverageA),
      personalDifference: semesterAverageA === null || recentAverageA === null
        ? null
        : rounded(recentAverageA - semesterAverageA),
      classComparisonCount: classDifferences.length,
      classAverageDifference: rounded(average(classDifferences)),
    };
    const currentMetric = currentMetricMap.get(student.id);
    const present = attendanceMap.has(student.id) ? attendanceMap.get(student.id) ?? null : null;
    const rawMetrics: StudentRawMetrics = {
      current: {
        metricId: currentMetric?.id,
        sessionId: session.id,
        date: session.date,
        semesterNumber: session.semesterNumber,
        scoreA: currentMetric?.scoreA ?? null,
        scoreB: currentMetric?.scoreB ?? null,
        scoreC: currentMetric?.scoreC ?? null,
        scoreD: currentMetric?.scoreD ?? null,
        present,
        events: currentEventTexts,
        eventRefs: (currentEventsByStudent.get(student.id) ?? []).map((event) => ({ id: event.id, description: event.description, sessionId: event.sessionId, type: event.type })),
      },
      recent: (recentMetricsByStudent.get(student.id) ?? []).map((metric) => ({
        metricId: metric.id,
        sessionId: metric.sessionId,
        date: metric.session?.date ?? metric.date,
        semesterNumber: metric.session?.semesterNumber ?? 0,
        scoreA: metric.scoreA,
        scoreB: metric.scoreB,
        scoreC: metric.scoreC,
        scoreD: metric.scoreD,
      })),
      communications: feedbackCommunications
        .slice(0, COMMUNICATION_PROMPT_LIMIT)
        .map((communication) => ({
          id: communication.id,
          sessionId: communication.sessionId,
          date: communication.feedbackDate,
          occurredAt: communication.occurredAt || communication.feedbackDate,
          target: communication.target,
          summary: shortSummary(communication.feedbackSummary),
        })),
      recentEventRefs: (recentEventsByStudent.get(student.id) ?? []).map((event) => ({
        id: event.id,
        description: event.description,
        sessionId: event.sessionId,
        type: event.type,
        date: event.session?.date,
      })),
      performanceBaseline: baseline,
    };

    const communicationPreference = student.communicationPreference
      ? (() => {
        try { return CommunicationPreferenceSchema.parse(JSON.parse(student.communicationPreference.preferenceSnapshot)); }
        catch { return undefined; }
      })()
      : undefined;
    const currentEventRefs = rawMetrics.current.eventRefs ?? [];
    const recentEventRefs = rawMetrics.recentEventRefs ?? [];
    const repeatedIssue = currentEventRefs.some((currentEvent) => recentEventRefs.some((recentEvent) => (
      recentEvent.id !== currentEvent.id && (
        currentEvent.type === recentEvent.type
        || ["犯困", "睡觉", "讲话", "注意力", "订正", "拖延"].some((keyword) => currentEvent.description.includes(keyword) && recentEvent.description.includes(keyword))
      )
    )));
    const feedbackRecommendationReasons = [
      ...(currentEventRefs.length > 0 ? ["本次有明确课堂事件"] : []),
      ...(currentEventRefs.some((event) => event.type === "教师处理") ? ["本次有已确认教师处理"] : []),
      ...(rawMetrics.current.scoreA !== null && (rawMetrics.current.scoreA <= 2 || rawMetrics.current.scoreA >= 5) ? ["本次有显著测验结果"] : []),
      ...(repeatedIssue ? ["近期重复出现同类问题"] : []),
      ...(rawMetrics.communications.length > 0 && currentEventRefs.length > 0 ? ["家长关切出现了新的课堂证据"] : []),
    ];
    return {
      id: student.id,
      name: student.name,
      studentId: student.studentId,
      labels,
      promptContext: buildPromptContext({
        studentName: student.name,
        sessionDate: session.date,
        semesterNumber: session.semesterNumber,
        labels,
        today,
        trend: promptRecentEventLines.length > 0 ? `${promptTrend}；近期事件：${promptRecentEventLines.join("；")}` : promptTrend,
        communications: promptCommunicationLines,
        baseline,
      }),
      preview,
      rawMetrics,
      feedbackRecommendationReasons,
      ...(communicationPreference ? { communicationPreference } : {}),
    };
  });

  return {
    session: {
      id: session.id,
      code: session.code,
      date: session.date,
      semesterId: session.semesterId,
      semesterNumber: session.semesterNumber,
      classId: session.classId,
    },
    className,
    total: contextStudents.length,
    students: contextStudents,
  };
}
