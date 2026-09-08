import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { FeedbackPlanInputSnapshotSchema } from "@/lib/feedback-plan";
import { feedbackPlanHasGenerationTrace } from "@/services/feedback-plan/model";

type FeedbackPlanDb = PrismaClient | Prisma.TransactionClient;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
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
      archivedAt: null,
      generationStartedAt: null,
      ...(classId ? { classId } : {}),
      ...(semesterId ? { semesterId } : {}),
      items: { some: { status: { in: ["evidence_ready", "generating", "needs_review"] } } },
    },
    select: {
      id: true,
      status: true,
      inputSnapshot: true,
      sessionId: true,
      rangeStartSessionId: true,
      rangeEndSessionId: true,
      generationStartedAt: true,
      generationCompletedAt: true,
      session: { select: { date: true, semesterNumber: true } },
      rangeStartSession: { select: { date: true, semesterNumber: true } },
      rangeEndSession: { select: { date: true, semesterNumber: true } },
      items: {
        select: {
          id: true,
          studentId: true,
          status: true,
          finalText: true,
          selectedGenerationId: true,
          approvedAt: true,
          exportedAt: true,
        },
      },
    },
  });
  const position = (session: { date: string; semesterNumber: number } | null | undefined) => session
    ? `${session.date}|${String(session.semesterNumber).padStart(6, "0")}`
    : null;
  const targetPosition = targetSession ? position(targetSession) : null;
  const matchingPlanIds = new Set(plans.filter((plan) => {
    if (feedbackPlanHasGenerationTrace(plan)) return false;
    const snapshot = FeedbackPlanInputSnapshotSchema.safeParse(parseJson(plan.inputSnapshot, null));
    // V2 plans own a durable fact snapshot from the moment they are created.
    // New facts must create another named plan instead of silently rebasing it.
    if (snapshot.success && snapshot.data.version === 2) return false;
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
