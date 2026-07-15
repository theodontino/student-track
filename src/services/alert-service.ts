import type { PrismaClient } from "@/generated/prisma/client";
import {
  ALERT_RULES,
  evaluateAbsenceAlert,
  evaluateClassAverageAlert,
  type AlertSeverity,
} from "@/config/rules";
import { ATTENTION_REASON_NAMES, attentionReasonsFromLabels } from "@/lib/attention-labels";
import { DIM_LABEL } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import {
  resolveSemester,
  localDate,
  type ResolvedSemester,
  type SemesterResolutionOptions,
} from "@/services/semester-service";
import {
  classifyStudentRisk,
  compositeScore,
  earlyRelativeStudentIds,
  persistentBelowAverageSignal,
  recentPerformanceDropSignal,
  usesEarlyRelativePerformance,
  type StudentRisk,
  type StudentRiskSignal,
} from "@/services/student-risk-service";

export type DashboardSemester = ResolvedSemester;

export interface ClassOverview {
  name: string;
  avgA: number;
  avgB: number;
  avgC: number;
  avgD: number;
  studentCount: number;
  lastActivityAt: string;
}

export interface StudentAlert {
  studentId: string;
  studentName: string;
  class: string;
  dimension: string;
  score: number;
  classAvg: number;
  deviation: number;
  severity: AlertSeverity;
  lastActivityAt: string;
}

export interface AttendanceReminder {
  studentId: string;
  studentName: string;
  className: string;
  absenceCount: number;
  level: "attention" | "warning";
}

export interface AlertDashboard {
  semester: DashboardSemester | null;
  classOverview: ClassOverview[];
  classAlerts: Array<{
    className: string;
    dimension: string;
    avgScore: number;
    severity: AlertSeverity;
  }>;
  studentAlerts: StudentAlert[];
  studentRisks: StudentRisk[];
  attendanceReminders: AttendanceReminder[];
  totalStudents: number;
  redCount: number;
  yellowCount: number;
  warningCount: number;
  attentionCount: number;
}

type AlertDashboardOptions = SemesterResolutionOptions;

function emptyDashboard(semester: DashboardSemester | null): AlertDashboard {
  return {
    semester,
    classOverview: [],
    classAlerts: [],
    studentAlerts: [],
    studentRisks: [],
    attendanceReminders: [],
    totalStudents: 0,
    redCount: 0,
    yellowCount: 0,
    warningCount: 0,
    attentionCount: 0,
  };
}

function maximumDate(values: Date[]) {
  if (values.length === 0) return new Date(0);
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

/** Calculates semester-isolated dashboard summaries and alerts. */
export async function getAlertDashboard(
  options: AlertDashboardOptions = {},
  db: PrismaClient = prisma,
): Promise<AlertDashboard> {
  const semester = await resolveSemester(db, options);
  if (!semester) return emptyDashboard(null);

  const today = localDate(options.now ?? new Date());
  const sessions = await db.classSession.findMany({
    where: { semesterId: semester.id, date: { lte: today } },
    orderBy: [{ date: "desc" }, { semesterNumber: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      date: true,
      semesterNumber: true,
      createdAt: true,
      classId: true,
      class: { select: { code: true, name: true } },
    },
  });
  if (sessions.length === 0) return emptyDashboard(semester);

  const sessionIds = sessions.map((session) => session.id);
  const sessionById = new Map(sessions.map((session, index) => [session.id, { ...session, rank: sessions.length - index }]));
  const [attendances, metrics, events, communications] = await Promise.all([
    db.attendance.findMany({ where: { sessionId: { in: sessionIds } } }),
    db.sessionMetric.findMany({ where: { sessionId: { in: sessionIds } } }),
    db.event.findMany({ where: { sessionId: { in: sessionIds } }, select: { studentId: true, sessionId: true, createdAt: true } }),
    db.communication.findMany({ where: { sessionId: { in: sessionIds } }, select: { studentId: true, sessionId: true, createdAt: true } }),
  ]);

  const studentSessionIds = new Map<string, Set<string>>();
  const activityDates = new Map<string, Date[]>();
  const registerActivity = (studentId: string, sessionId: string, createdAt: Date) => {
    const participated = studentSessionIds.get(studentId) ?? new Set<string>();
    participated.add(sessionId);
    studentSessionIds.set(studentId, participated);
    activityDates.set(studentId, [...(activityDates.get(studentId) ?? []), createdAt]);
  };
  for (const item of attendances) registerActivity(item.studentId, item.sessionId, item.createdAt);
  for (const item of metrics) {
    if (item.sessionId) registerActivity(item.studentId, item.sessionId, item.createdAt);
  }
  for (const item of events) registerActivity(item.studentId, item.sessionId, item.createdAt);
  for (const item of communications) registerActivity(item.studentId, item.sessionId, item.createdAt);

  const studentIds = [...studentSessionIds.keys()];
  if (studentIds.length === 0) return emptyDashboard(semester);
  const students = await db.student.findMany({
    where: { id: { in: studentIds } },
    select: {
      id: true,
      name: true,
      studentLabels: { select: { label: { select: { name: true } } } },
    },
  });
  const studentById = new Map(students.map((student) => [student.id, student]));

  const assignedSessionByStudent = new Map<string, typeof sessions[number]>();
  for (const [studentId, participatedSessionIds] of studentSessionIds) {
    let latest: (typeof sessions[number] & { rank: number }) | undefined;
    for (const sessionId of participatedSessionIds) {
      const candidate = sessionById.get(sessionId);
      if (candidate && (!latest || candidate.rank > latest.rank)) latest = candidate;
    }
    if (latest) assignedSessionByStudent.set(studentId, latest);
  }

  const latestMetricByStudent = new Map<string, typeof metrics[number]>();
  for (const metric of metrics) {
    if (!metric.sessionId) continue;
    const existing = latestMetricByStudent.get(metric.studentId);
    const metricRank = sessionById.get(metric.sessionId)?.rank ?? 0;
    const existingRank = existing?.sessionId ? sessionById.get(existing.sessionId)?.rank ?? 0 : -1;
    if (!existing || metricRank > existingRank || (
      metricRank === existingRank && metric.createdAt > existing.createdAt
    )) latestMetricByStudent.set(metric.studentId, metric);
  }

  const classStudents = new Map<string, string[]>();
  const classNames = new Map<string, string>();
  for (const studentId of studentIds) {
    if (!studentById.has(studentId)) continue;
    const session = assignedSessionByStudent.get(studentId);
    if (!session) continue;
    const classKey = session.classId ?? "__school__";
    const className = session.class?.name ?? session.class?.code ?? "全校";
    classNames.set(classKey, className);
    classStudents.set(classKey, [...(classStudents.get(classKey) ?? []), studentId]);
  }

  const classOverview: ClassOverview[] = [];
  const classOverviewByKey = new Map<string, ClassOverview>();
  const classAlerts: AlertDashboard["classAlerts"] = [];
  for (const [classKey, classStudentIds] of classStudents) {
    const latestMetrics = classStudentIds
      .map((studentId) => latestMetricByStudent.get(studentId))
      .filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));
    const average = (key: "scoreA" | "scoreB" | "scoreC" | "scoreD") => (
      latestMetrics.length === 0
        ? 0
        : +(latestMetrics.reduce((sum, metric) => sum + metric[key], 0) / latestMetrics.length).toFixed(1)
    );
    const overview: ClassOverview = {
      name: classNames.get(classKey) ?? "全校",
      avgA: average("scoreA"),
      avgB: average("scoreB"),
      avgC: average("scoreC"),
      avgD: average("scoreD"),
      studentCount: classStudentIds.length,
      lastActivityAt: maximumDate(classStudentIds.flatMap((id) => activityDates.get(id) ?? [])).toISOString(),
    };
    classOverview.push(overview);
    classOverviewByKey.set(classKey, overview);

    if (classStudentIds.length >= ALERT_RULES.classAverage.minimumClassSize && latestMetrics.length > 0) {
      for (const dimension of ["A", "B", "C"] as const) {
        const avgScore = overview[`avg${dimension}`];
        const severity = evaluateClassAverageAlert(avgScore);
        if (severity) classAlerts.push({ className: overview.name, dimension: DIM_LABEL[dimension], avgScore, severity });
      }
    }
  }
  classOverview.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));

  const metricsByStudent = new Map<string, typeof metrics>();
  const metricsBySession = new Map<string, typeof metrics>();
  for (const metric of metrics) {
    metricsByStudent.set(metric.studentId, [...(metricsByStudent.get(metric.studentId) ?? []), metric]);
    if (metric.sessionId) metricsBySession.set(metric.sessionId, [...(metricsBySession.get(metric.sessionId) ?? []), metric]);
  }
  const classAverageBySession = new Map<string, number>();
  for (const [sessionId, sessionMetrics] of metricsBySession) {
    if (sessionMetrics.length < ALERT_RULES.studentRanking.minimumStudents) continue;
    classAverageBySession.set(sessionId, +(sessionMetrics.reduce((sum, metric) => sum + compositeScore(metric), 0) / sessionMetrics.length).toFixed(2));
  }

  const absenceMap = new Map<string, number>();
  for (const attendance of attendances) {
    if (!attendance.present) absenceMap.set(attendance.studentId, (absenceMap.get(attendance.studentId) ?? 0) + 1);
  }
  const attendanceReminders: AttendanceReminder[] = [];
  const attendanceExcludedStudentIds = new Set<string>();
  for (const studentId of studentIds) {
    const student = studentById.get(studentId);
    const session = assignedSessionByStudent.get(studentId);
    if (!student || !session) continue;
    const absences = absenceMap.get(studentId) ?? 0;
    const severity = evaluateAbsenceAlert(absences);
    if (!severity) continue;
    attendanceExcludedStudentIds.add(studentId);
    attendanceReminders.push({
      studentId,
      studentName: student.name,
      className: session.class?.name ?? session.class?.code ?? "全校",
      absenceCount: absences,
      level: severity === "red" ? "warning" : "attention",
    });
  }

  const currentSemester = options.semesterId ? await resolveSemester(db, { now: options.now }) : semester;
  const includeQualitativeFeedback = currentSemester?.id === semester.id;
  const studentRisks: StudentRisk[] = [];
  for (const [classKey, classStudentIds] of classStudents) {
    const overview = classOverviewByKey.get(classKey);
    if (!overview) continue;
    const rankedStudentIds = classStudentIds.filter((studentId) => !attendanceExcludedStudentIds.has(studentId));
    const occurredClassSessionCount = sessions.filter((session) => (session.classId ?? "__school__") === classKey).length;
    const earlyIds = usesEarlyRelativePerformance(occurredClassSessionCount)
      ? earlyRelativeStudentIds(rankedStudentIds.flatMap((studentId) => {
          const metric = latestMetricByStudent.get(studentId);
          if (!metric) return [];
          const averageDeviation = +((
            (metric.scoreA - overview.avgA)
            + (metric.scoreB - overview.avgB)
            + (metric.scoreC - overview.avgC)
          ) / 3).toFixed(1);
          return [{ studentId, averageDeviation }];
        }))
      : new Set<string>();

    for (const studentId of rankedStudentIds) {
      const student = studentById.get(studentId);
      if (!student) continue;
      const signals: StudentRiskSignal[] = [];
      const chronologicalMetrics = [...(metricsByStudent.get(studentId) ?? [])]
        .filter((metric) => Boolean(metric.sessionId && sessionById.has(metric.sessionId)))
        .sort((left, right) => (sessionById.get(left.sessionId ?? "")?.rank ?? 0) - (sessionById.get(right.sessionId ?? "")?.rank ?? 0));
      const points = chronologicalMetrics.map((metric) => ({
        sessionId: metric.sessionId ?? "",
        composite: compositeScore(metric),
        classAverage: metric.sessionId ? classAverageBySession.get(metric.sessionId) ?? null : null,
      }));

      if (usesEarlyRelativePerformance(occurredClassSessionCount)) {
        if (earlyIds.has(studentId)) signals.push({
          type: "early-relative-performance",
          label: "早期相对表现",
          evidence: "前四次课数据仍较少，当前综合表现处于班级相对靠后区间",
        });
      } else {
        const decline = recentPerformanceDropSignal(points);
        const participatedCount = studentSessionIds.get(studentId)?.size ?? occurredClassSessionCount;
        const belowAverage = persistentBelowAverageSignal(points, participatedCount);
        if (decline) signals.push(decline);
        if (belowAverage) signals.push(belowAverage);
      }

      const qualitativeReasons = includeQualitativeFeedback
        ? attentionReasonsFromLabels(student.studentLabels.map((item) => item.label.name))
        : [];
      if (qualitativeReasons.length > 0) signals.push({
        type: "qualitative-feedback",
        label: "定性反馈关注",
        evidence: `内部反馈：${qualitativeReasons.map((reason) => ATTENTION_REASON_NAMES[reason]).join("、")}`,
      });
      const risk = classifyStudentRisk({
        studentId,
        studentName: student.name,
        className: overview.name,
        signals,
        qualitativeReasons,
        lastActivityAt: maximumDate(activityDates.get(studentId) ?? []).toISOString(),
      });
      if (risk) studentRisks.push(risk);
    }
  }

  studentRisks.sort((left, right) => {
    if (left.level !== right.level) return left.level === "warning" ? -1 : 1;
    if (left.signals.length !== right.signals.length) return right.signals.length - left.signals.length;
    return right.lastActivityAt.localeCompare(left.lastActivityAt) || left.studentName.localeCompare(right.studentName, "zh-CN");
  });
  attendanceReminders.sort((left, right) => (left.level === right.level ? right.absenceCount - left.absenceCount : left.level === "warning" ? -1 : 1));
  const warningCount = studentRisks.filter((risk) => risk.level === "warning").length;
  const attentionCount = studentRisks.filter((risk) => risk.level === "attention").length;
  const studentAlerts: StudentAlert[] = studentRisks.map((risk) => ({
    studentId: risk.studentId,
    studentName: risk.studentName,
    class: risk.className,
    dimension: risk.signals.map((signal) => signal.label).join(" + "),
    score: risk.signals.length,
    classAvg: 0,
    deviation: 0,
    severity: risk.level === "warning" ? "red" : "yellow",
    lastActivityAt: risk.lastActivityAt,
  }));

  return {
    semester,
    classOverview,
    classAlerts,
    studentAlerts,
    studentRisks,
    attendanceReminders,
    totalStudents: studentById.size,
    redCount: warningCount,
    yellowCount: attentionCount,
    warningCount,
    attentionCount,
  };
}
