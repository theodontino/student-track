import type { PrismaClient } from "@/generated/prisma/client";
import { calculateAttendanceScore } from "@/config/rules";
import { prisma } from "@/lib/prisma";
import {
  localDate,
  resolveSemester,
  type ResolvedSemester,
  type SemesterResolutionOptions,
} from "@/services/semester-service";

export interface StudentSemesterSummary {
  semester: ResolvedSemester;
  averageA: number | null;
  averageB: number | null;
  averageC: number | null;
  attendanceScore: number | null;
  total20: number | null;
  score100: number | null;
  ratedSessionCount: number;
  attendanceRecordedCount: number;
  presentCount: number;
}

interface MetricScore {
  scoreA: number;
  scoreB: number;
  scoreC: number;
}

interface AttendanceRecord {
  present: boolean;
}

function oneDecimal(value: number) {
  return Number(value.toFixed(1));
}

export function calculateStudentSemesterSummary(input: {
  semester: ResolvedSemester;
  metrics: MetricScore[];
  attendances: AttendanceRecord[];
}): StudentSemesterSummary {
  const rawAverage = (key: keyof MetricScore) => input.metrics.length === 0
    ? null
    : input.metrics.reduce((sum, metric) => sum + metric[key], 0) / input.metrics.length;
  const rawA = rawAverage("scoreA");
  const rawB = rawAverage("scoreB");
  const rawC = rawAverage("scoreC");
  const presentCount = input.attendances.filter((attendance) => attendance.present).length;
  const attendanceScore = input.attendances.length === 0
    ? null
    : calculateAttendanceScore(presentCount, input.attendances.length);
  const rawTotal = rawA === null || rawB === null || rawC === null || attendanceScore === null
    ? null
    : rawA + rawB + rawC + attendanceScore;

  return {
    semester: input.semester,
    averageA: rawA === null ? null : oneDecimal(rawA),
    averageB: rawB === null ? null : oneDecimal(rawB),
    averageC: rawC === null ? null : oneDecimal(rawC),
    attendanceScore,
    total20: rawTotal === null ? null : oneDecimal(rawTotal),
    score100: rawTotal === null ? null : Math.round(rawTotal * 5),
    ratedSessionCount: input.metrics.length,
    attendanceRecordedCount: input.attendances.length,
    presentCount,
  };
}

/** Calculates semester summaries with a fixed number of database reads. */
export async function getStudentSemesterSummaries(
  studentIds: string[],
  options: SemesterResolutionOptions = {},
  db: PrismaClient = prisma,
) {
  const uniqueStudentIds = [...new Set(studentIds.filter(Boolean))];
  const semester = await resolveSemester(db, options);
  const summaries = new Map<string, StudentSemesterSummary>();
  if (!semester || uniqueStudentIds.length === 0) return { semester, summaries };

  const asOfDate = localDate(options.now ?? new Date());
  const sessions = await db.classSession.findMany({
    where: { semesterId: semester.id, date: { lte: asOfDate } },
    select: { id: true },
  });
  const sessionIds = sessions.map((session) => session.id);
  if (sessionIds.length === 0) {
    for (const studentId of uniqueStudentIds) {
      summaries.set(studentId, calculateStudentSemesterSummary({ semester, metrics: [], attendances: [] }));
    }
    return { semester, summaries };
  }

  const [metrics, attendances] = await Promise.all([
    db.sessionMetric.findMany({
      where: { studentId: { in: uniqueStudentIds }, sessionId: { in: sessionIds } },
      select: { studentId: true, scoreA: true, scoreB: true, scoreC: true },
    }),
    db.attendance.findMany({
      where: { studentId: { in: uniqueStudentIds }, sessionId: { in: sessionIds } },
      select: { studentId: true, present: true },
    }),
  ]);

  const metricsByStudent = new Map<string, MetricScore[]>();
  for (const metric of metrics) {
    const values = metricsByStudent.get(metric.studentId) ?? [];
    values.push({ scoreA: metric.scoreA, scoreB: metric.scoreB, scoreC: metric.scoreC });
    metricsByStudent.set(metric.studentId, values);
  }
  const attendanceByStudent = new Map<string, AttendanceRecord[]>();
  for (const attendance of attendances) {
    const values = attendanceByStudent.get(attendance.studentId) ?? [];
    values.push({ present: attendance.present });
    attendanceByStudent.set(attendance.studentId, values);
  }

  for (const studentId of uniqueStudentIds) {
    summaries.set(studentId, calculateStudentSemesterSummary({
      semester,
      metrics: metricsByStudent.get(studentId) ?? [],
      attendances: attendanceByStudent.get(studentId) ?? [],
    }));
  }

  return { semester, summaries };
}
