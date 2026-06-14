import {
  ALERT_RULES,
  calculateStudentAlertCutoffs,
  evaluateAbsenceAlert,
  evaluateClassAverageAlert,
  type AlertSeverity,
} from "@/config/rules";
import { DIM_LABEL } from "@/lib/constants";
import { prisma } from "@/lib/prisma";

interface ClassOverview {
  name: string;
  avgA: number;
  avgB: number;
  avgC: number;
  avgD: number;
  studentCount: number;
}

interface StudentAlert {
  studentId: string;
  studentName: string;
  class: string;
  dimension: string;
  score: number;
  classAvg: number;
  deviation: number;
  severity: AlertSeverity;
}

function currentDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Calculates dashboard summaries and alerts from current persisted data. */
export async function getAlertDashboard() {
  const students = await prisma.student.findMany({
    include: { class: { select: { name: true, code: true } } },
  });
  if (students.length === 0) {
    return {
      classOverview: [],
      classAlerts: [],
      studentAlerts: [],
      totalStudents: 0,
      redCount: 0,
      yellowCount: 0,
    };
  }

  const allMetrics = await prisma.sessionMetric.findMany({
    where: { studentId: { in: students.map((student) => student.id) } },
    orderBy: { createdAt: "desc" },
  });
  const metricsByStudent = new Map<string, typeof allMetrics>();
  for (const metric of allMetrics) {
    const metrics = metricsByStudent.get(metric.studentId) ?? [];
    if (metrics.length < 3) metrics.push(metric);
    metricsByStudent.set(metric.studentId, metrics);
  }

  const semester = await prisma.semester.findFirst({
    where: { startDate: { lte: currentDate() }, endDate: { gte: currentDate() } },
    orderBy: { startDate: "desc" },
    include: { sessions: { select: { id: true } } },
  });
  const sessionIds = semester?.sessions.map((session) => session.id) ?? [];
  const absenceMap = new Map<string, number>();
  if (sessionIds.length > 0) {
    const attendances = await prisma.attendance.findMany({
      where: { sessionId: { in: sessionIds }, present: false },
      select: { studentId: true },
    });
    for (const attendance of attendances) {
      absenceMap.set(attendance.studentId, (absenceMap.get(attendance.studentId) ?? 0) + 1);
    }
  }

  const classStudents = new Map<string, typeof students>();
  for (const student of students) {
    const className = student.class.name ?? student.class.code;
    classStudents.set(className, [...(classStudents.get(className) ?? []), student]);
  }

  const classOverview: ClassOverview[] = [];
  const classAlerts: Array<{
    className: string;
    dimension: string;
    avgScore: number;
    severity: AlertSeverity;
  }> = [];

  for (const [className, classRoster] of classStudents) {
    const latestMetrics = classRoster
      .map((student) => metricsByStudent.get(student.id)?.[0])
      .filter((metric): metric is NonNullable<typeof metric> => Boolean(metric));
    if (latestMetrics.length === 0) {
      classOverview.push({
        name: className,
        avgA: 0,
        avgB: 0,
        avgC: 0,
        avgD: 0,
        studentCount: classRoster.length,
      });
      continue;
    }

    const average = (key: "scoreA" | "scoreB" | "scoreC" | "scoreD") => (
      +(latestMetrics.reduce((sum, metric) => sum + metric[key], 0) / latestMetrics.length).toFixed(1)
    );
    const overview = {
      name: className,
      avgA: average("scoreA"),
      avgB: average("scoreB"),
      avgC: average("scoreC"),
      avgD: average("scoreD"),
      studentCount: classRoster.length,
    };
    classOverview.push(overview);

    if (classRoster.length >= ALERT_RULES.classAverage.minimumClassSize) {
      for (const dimension of ["A", "B", "C"] as const) {
        const avgScore = overview[`avg${dimension}`];
        const severity = evaluateClassAverageAlert(avgScore);
        if (severity) classAlerts.push({ className, dimension: DIM_LABEL[dimension], avgScore, severity });
      }
    }
  }

  const studentAlerts: StudentAlert[] = [];
  for (const [className, classRoster] of classStudents) {
    const overview = classOverview.find((entry) => entry.name === className);
    if (!overview) continue;
    const averages = { A: overview.avgA, B: overview.avgB, C: overview.avgC };
    type RankedEntry = {
      student: typeof students[number];
      devA: number;
      devB: number;
      devC: number;
      avgDev: number;
      scoreA: number;
      scoreB: number;
      scoreC: number;
    };
    const ranked: RankedEntry[] = [];
    for (const student of classRoster) {
      const metric = metricsByStudent.get(student.id)?.[0];
      if (!metric) continue;
      const devA = +(metric.scoreA - averages.A).toFixed(1);
      const devB = +(metric.scoreB - averages.B).toFixed(1);
      const devC = +(metric.scoreC - averages.C).toFixed(1);
      ranked.push({
        student,
        devA,
        devB,
        devC,
        avgDev: +((devA + devB + devC) / 3).toFixed(1),
        scoreA: metric.scoreA,
        scoreB: metric.scoreB,
        scoreC: metric.scoreC,
      });
    }
    if (ranked.length < ALERT_RULES.studentRanking.minimumStudents) continue;

    ranked.sort((left, right) => left.avgDev - right.avgDev);
    const { red, yellow } = calculateStudentAlertCutoffs(ranked.length);
    const expandTies = (base: number) => {
      if (base >= ranked.length) return ranked.length;
      const maximum = Math.min(
        ranked.length,
        Math.ceil(base * ALERT_RULES.studentRanking.tieExpansionMultiplier),
      );
      const boundary = ranked[base - 1].avgDev;
      let index = base;
      while (index < maximum && ranked[index].avgDev === boundary) index++;
      return index;
    };
    const redEnd = expandTies(red);
    const yellowEnd = expandTies(yellow);

    const addAlert = (entry: RankedEntry, severity: AlertSeverity) => {
      const belowAverage = ([
        ["A", entry.devA, entry.scoreA],
        ["B", entry.devB, entry.scoreB],
        ["C", entry.devC, entry.scoreC],
      ] as const).filter(([, deviation]) => deviation < 0).sort((a, b) => a[1] - b[1]);
      if (belowAverage.length === 0) return;
      const worst = belowAverage[0];
      studentAlerts.push({
        studentId: entry.student.id,
        studentName: entry.student.name,
        class: entry.student.class.name ?? entry.student.class.code,
        dimension: DIM_LABEL[worst[0]],
        score: worst[2],
        classAvg: averages[worst[0]],
        deviation: worst[1],
        severity,
      });
    };
    for (let index = 0; index < redEnd; index++) addAlert(ranked[index], "red");
    for (let index = redEnd; index < yellowEnd; index++) addAlert(ranked[index], "yellow");
  }

  if (sessionIds.length > 0) {
    for (const student of students) {
      const absences = absenceMap.get(student.id) ?? 0;
      const severity = evaluateAbsenceAlert(absences);
      if (!severity) continue;
      studentAlerts.push({
        studentId: student.id,
        studentName: student.name,
        class: student.class.name ?? student.class.code,
        dimension: DIM_LABEL.D,
        score: absences,
        classAvg: sessionIds.length,
        deviation: 0,
        severity,
      });
    }
  }

  const deduplicated = new Map<string, StudentAlert>();
  for (const alert of studentAlerts) {
    const key = `${alert.studentId}|${alert.dimension}`;
    const existing = deduplicated.get(key);
    if (!existing || (alert.severity === "red" && existing.severity === "yellow")) {
      deduplicated.set(key, alert);
    }
  }
  const finalStudentAlerts = [...deduplicated.values()];
  return {
    classOverview,
    classAlerts,
    studentAlerts: finalStudentAlerts,
    totalStudents: students.length,
    redCount: finalStudentAlerts.filter((alert) => alert.severity === "red").length,
    yellowCount: finalStudentAlerts.filter((alert) => alert.severity === "yellow").length,
  };
}
