import type { PrismaClient } from "@/generated/prisma/client";
import type { FeedbackContextResult } from "@/services/feedback-context-service";
import { getAlertDashboard } from "@/services/alert-service";
import { listTeacherObservations } from "@/services/teacher-observation-service";
import type {
  AutomaticFeedbackIntensity,
  FeedbackRoutingDecision,
  FeedbackRoutingReason,
} from "@/lib/feedback-intensity";

const ACTIVE_OBSERVATION_STATUSES = ["new", "read", "deferred"] as const;
const OBSERVATION_WINDOW_DAYS = 21;

function localDay(value: string) {
  return new Date(`${value}T00:00:00.000Z`).getTime();
}

function hasRecentObservation(occurredAt: string, sessionDate: string) {
  const delta = localDay(sessionDate) - localDay(occurredAt.slice(0, 10));
  return delta >= 0 && delta < OBSERVATION_WINDOW_DAYS;
}

/**
 * Determines how much review a feedback item deserves. It never returns
 * observation text or Dashboard signal details for parent-facing generation.
 */
export async function buildFeedbackRouting(
  db: PrismaClient,
  context: FeedbackContextResult,
): Promise<FeedbackRoutingDecision[]> {
  const [dashboard, observations] = await Promise.all([
    getAlertDashboard({ semesterId: context.session.semesterId }, db),
    listTeacherObservations({
      semesterId: context.session.semesterId,
      statuses: [...ACTIVE_OBSERVATION_STATUSES],
      studentIds: context.students.map((student) => student.id),
      limit: 1000,
    }, db),
  ]);
  const classStudentIds = new Set(context.students.map((student) => student.id));
  const riskByStudent = new Map(
    dashboard.studentRisks
      .filter((risk) => classStudentIds.has(risk.studentId))
      .map((risk) => [risk.studentId, risk.level]),
  );
  const observedStudentIds = new Set(
    observations
      .filter((observation) => classStudentIds.has(observation.student.id))
      .filter((observation) => observation.sources.some((source) => (
        hasRecentObservation(source.occurredAt, context.session.date)
      )))
      .map((observation) => observation.student.id),
  );

  return context.students.map((student) => {
    const reasons: FeedbackRoutingReason[] = [];
    const risk = riskByStudent.get(student.id);
    if (risk === "warning") reasons.push("dashboard-warning");
    if (risk === "attention") reasons.push("dashboard-attention");
    if (observedStudentIds.has(student.id)) reasons.push("recent-teacher-observation");
    const baseline: AutomaticFeedbackIntensity = reasons.includes("dashboard-warning")
      || (reasons.includes("dashboard-attention") && reasons.includes("recent-teacher-observation"))
      ? "priority"
      : reasons.length > 0 ? "attention" : "routine";
    return { studentId: student.id, baseline, intensity: baseline, reasons };
  });
}
