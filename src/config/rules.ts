export type AlertSeverity = "red" | "yellow";

export const SCORE_RULES = {
  minimum: 0,
  maximum: 5,
  default: 3,
} as const;

export const ATTENDANCE_SCORE_RULES = {
  maximum: 5,
} as const;

export const ALERT_RULES = {
  classAverage: {
    minimumClassSize: 5,
    redBelow: 2.5,
    yellowBelow: 3,
  },
  studentRanking: {
    minimumStudents: 3,
    redFraction: 0.1,
    yellowFraction: 0.2,
    tieExpansionMultiplier: 1.5,
  },
  absence: {
    redAt: 4,
    yellowAt: 2,
  },
} as const;

export function normalizeDimensionScore(value: unknown, fallback = SCORE_RULES.default) {
  const numeric = Number(value ?? fallback);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.max(SCORE_RULES.minimum, Math.min(SCORE_RULES.maximum, numeric)));
}

export function calculateAttendanceScore(presentCount: number, totalSessions: number) {
  if (totalSessions <= 0) return SCORE_RULES.default;
  return Math.round((ATTENDANCE_SCORE_RULES.maximum * presentCount) / totalSessions);
}

export function evaluateClassAverageAlert(average: number): AlertSeverity | null {
  if (average < ALERT_RULES.classAverage.redBelow) return "red";
  if (average < ALERT_RULES.classAverage.yellowBelow) return "yellow";
  return null;
}

export function evaluateAbsenceAlert(absences: number): AlertSeverity | null {
  if (absences >= ALERT_RULES.absence.redAt) return "red";
  if (absences >= ALERT_RULES.absence.yellowAt) return "yellow";
  return null;
}

export function calculateStudentAlertCutoffs(total: number) {
  const red = Math.max(1, Math.ceil(total * ALERT_RULES.studentRanking.redFraction));
  const yellow = Math.max(red + 1, Math.ceil(total * ALERT_RULES.studentRanking.yellowFraction));
  return { red, yellow };
}
