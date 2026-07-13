import type { PrismaClient } from "@/generated/prisma/client";
import {
  ALERT_RULES,
  calculateStudentAlertCutoffs,
  evaluateAbsenceAlert,
  evaluateClassAverageAlert,
  type AlertSeverity,
} from "@/config/rules";
import { DIM_LABEL } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import {
  resolveSemester,
  type ResolvedSemester,
  type SemesterResolutionOptions,
} from "@/services/semester-service";

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
  totalStudents: number;
  redCount: number;
  yellowCount: number;
}

type AlertDashboardOptions = SemesterResolutionOptions;

function emptyDashboard(semester: DashboardSemester | null): AlertDashboard {
  return {
    semester,
    classOverview: [],
    classAlerts: [],
    studentAlerts: [],
    totalStudents: 0,
    redCount: 0,
    yellowCount: 0,
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

  const sessions = await db.classSession.findMany({
    where: { semesterId: semester.id },
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
    select: { id: true, name: true },
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

  const studentAlerts: StudentAlert[] = [];
  for (const [classKey, classStudentIds] of classStudents) {
    const overview = classOverviewByKey.get(classKey);
    if (!overview) continue;
    const averages = { A: overview.avgA, B: overview.avgB, C: overview.avgC };
    const ranked = classStudentIds.flatMap((studentId) => {
      const student = studentById.get(studentId);
      const metric = latestMetricByStudent.get(studentId);
      if (!student || !metric) return [];
      const devA = +(metric.scoreA - averages.A).toFixed(1);
      const devB = +(metric.scoreB - averages.B).toFixed(1);
      const devC = +(metric.scoreC - averages.C).toFixed(1);
      return [{ student, metric, devA, devB, devC, avgDev: +((devA + devB + devC) / 3).toFixed(1) }];
    });
    if (ranked.length < ALERT_RULES.studentRanking.minimumStudents) continue;
    ranked.sort((left, right) => left.avgDev - right.avgDev);

    const { red, yellow } = calculateStudentAlertCutoffs(ranked.length);
    const expandTies = (base: number) => {
      if (base >= ranked.length) return ranked.length;
      const maximum = Math.min(ranked.length, Math.ceil(base * ALERT_RULES.studentRanking.tieExpansionMultiplier));
      const boundary = ranked[base - 1].avgDev;
      let index = base;
      while (index < maximum && ranked[index].avgDev === boundary) index++;
      return index;
    };
    const redEnd = expandTies(red);
    const yellowEnd = expandTies(yellow);
    const addAlert = (entry: typeof ranked[number], severity: AlertSeverity) => {
      const belowAverage = ([
        ["A", entry.devA, entry.metric.scoreA],
        ["B", entry.devB, entry.metric.scoreB],
        ["C", entry.devC, entry.metric.scoreC],
      ] as const).filter(([, deviation]) => deviation < 0).sort((a, b) => a[1] - b[1]);
      if (belowAverage.length === 0) return;
      const worst = belowAverage[0];
      studentAlerts.push({
        studentId: entry.student.id,
        studentName: entry.student.name,
        class: overview.name,
        dimension: DIM_LABEL[worst[0]],
        score: worst[2],
        classAvg: averages[worst[0]],
        deviation: worst[1],
        severity,
        lastActivityAt: maximumDate(activityDates.get(entry.student.id) ?? []).toISOString(),
      });
    };
    for (let index = 0; index < redEnd; index++) addAlert(ranked[index], "red");
    for (let index = redEnd; index < yellowEnd; index++) addAlert(ranked[index], "yellow");
  }

  const absenceMap = new Map<string, number>();
  for (const attendance of attendances) {
    if (!attendance.present) absenceMap.set(attendance.studentId, (absenceMap.get(attendance.studentId) ?? 0) + 1);
  }
  for (const studentId of studentIds) {
    const student = studentById.get(studentId);
    const session = assignedSessionByStudent.get(studentId);
    if (!student || !session) continue;
    const absences = absenceMap.get(studentId) ?? 0;
    const severity = evaluateAbsenceAlert(absences);
    if (!severity) continue;
    studentAlerts.push({
      studentId,
      studentName: student.name,
      class: session.class?.name ?? session.class?.code ?? "全校",
      dimension: DIM_LABEL.D,
      score: absences,
      classAvg: sessions.filter((item) => item.classId === session.classId).length,
      deviation: 0,
      severity,
      lastActivityAt: maximumDate(activityDates.get(studentId) ?? []).toISOString(),
    });
  }

  const deduplicated = new Map<string, StudentAlert>();
  for (const alert of studentAlerts) {
    const key = `${alert.studentId}|${alert.dimension}`;
    const existing = deduplicated.get(key);
    if (!existing || (alert.severity === "red" && existing.severity === "yellow")) deduplicated.set(key, alert);
  }
  const finalStudentAlerts = [...deduplicated.values()].sort((left, right) => {
    const activityOrder = right.lastActivityAt.localeCompare(left.lastActivityAt);
    if (activityOrder !== 0) return activityOrder;
    if (left.severity !== right.severity) return left.severity === "red" ? -1 : 1;
    return left.studentName.localeCompare(right.studentName, "zh-CN");
  });

  return {
    semester,
    classOverview,
    classAlerts,
    studentAlerts: finalStudentAlerts,
    totalStudents: studentById.size,
    redCount: finalStudentAlerts.filter((alert) => alert.severity === "red").length,
    yellowCount: finalStudentAlerts.filter((alert) => alert.severity === "yellow").length,
  };
}
