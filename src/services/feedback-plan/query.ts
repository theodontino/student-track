import type { PrismaClient } from "@/generated/prisma/client";
import {
  feedbackGenerationApproachLabel,
  normalizeStoredFeedbackGenerationApproach
} from "@/lib/feedback-generation-approach";
import { feedbackPlanActionBucket } from "@/lib/feedback-plan-summary";
import { prisma } from "@/lib/prisma";
import {
  assertFeedbackPlanAvailable
} from "@/services/academic-scope-recycle-service";
import { validateFeedbackPlanAttachments } from "@/services/feedback-attachment-service";
import { FeedbackPlanDb, generationProgress } from "@/services/feedback-plan/model";

export async function getFeedbackPlan(id: string, db: FeedbackPlanDb = prisma) {
  const plan = await db.feedbackPlan.findUnique({
    where: { id },
    include: {
      items: { include: { student: { include: { communicationPreference: true, communicationPreferenceCandidates: { where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 1 } } }, tasks: true, attachments: true, selectedGeneration: true } },
      tasks: true,
      attachments: true,
      exportRuns: { orderBy: { createdAt: "desc" } },
      session: { select: { id: true, code: true, date: true, semesterNumber: true } },
      rangeStartSession: { select: { id: true, code: true, date: true, semesterNumber: true } },
      rangeEndSession: { select: { id: true, code: true, date: true, semesterNumber: true } },
      class: { select: { id: true, code: true, name: true } },
      semester: { select: { id: true, name: true } },
    },
  });
  if (!plan) return null;
  await assertFeedbackPlanAvailable(id, db);
  const checked = await validateFeedbackPlanAttachments(id, db);
  if (checked.some((entry) => plan.attachments.some((attachment) => attachment.id === entry.id && attachment.status !== entry.status))) {
    return db.feedbackPlan.findUnique({
      where: { id },
      include: { items: { include: { student: { include: { communicationPreference: true, communicationPreferenceCandidates: { where: { status: "pending" }, orderBy: { createdAt: "desc" }, take: 1 } } }, tasks: true, attachments: true, selectedGeneration: true } }, tasks: true, attachments: true, exportRuns: { orderBy: { createdAt: "desc" } }, session: { select: { id: true, code: true, date: true, semesterNumber: true } }, rangeStartSession: { select: { id: true, code: true, date: true, semesterNumber: true } }, rangeEndSession: { select: { id: true, code: true, date: true, semesterNumber: true } }, class: { select: { id: true, code: true, name: true } }, semester: { select: { id: true, name: true } } },
    });
  }
  return plan;
}

export async function listFeedbackPlans(input: {
  classId?: string;
  semesterId?: string;
  sessionId?: string;
  studentId?: string;
  date?: string;
  status?: string;
  archived?: boolean;
  type?: string;
}, db: PrismaClient = prisma) {
  const relationFilters = [
    ...(input.sessionId ? [{ OR: [
      { type: { in: ["stage_trend", "course_end"] }, rangeEndSessionId: input.sessionId },
      { type: { notIn: ["stage_trend", "course_end"] }, sessionId: input.sessionId },
    ] }] : []),
    ...(input.date ? [{ OR: [
      { type: { in: ["stage_trend", "course_end"] }, rangeEndSession: { is: { date: input.date } } },
      { type: { notIn: ["stage_trend", "course_end"] }, session: { is: { date: input.date } } },
    ] }] : []),
  ];
  const plans = await db.feedbackPlan.findMany({
    where: {
      semester: { deletedAt: null },
      class: { deletedAt: null },
      OR: [
        { batchId: null },
        { batch: { is: { plans: { none: { class: { deletedAt: { not: null } } } } } } },
      ],
      ...(input.classId ? { classId: input.classId } : {}),
      ...(input.semesterId ? { semesterId: input.semesterId } : {}),
      ...(input.studentId ? { items: { some: { studentId: input.studentId } } } : {}),
      ...(relationFilters.length ? { AND: relationFilters } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.archived === true ? { archivedAt: { not: null } } : input.archived === false ? { archivedAt: null } : {}),
      ...(input.type ? { type: input.type } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: {
      session: { select: { id: true, code: true, date: true, semesterNumber: true } },
      rangeEndSession: { select: { id: true, code: true, date: true, semesterNumber: true } },
      class: { select: { id: true, code: true, name: true } },
      semester: { select: { id: true, name: true } },
      items: { select: { id: true, studentId: true, status: true, finalTextHash: true, updatedAt: true, student: { select: { id: true, name: true, studentId: true } } } },
    },
  });
  return plans.map((plan) => ({
    ...plan,
    generationApproach: normalizeStoredFeedbackGenerationApproach(plan.generationApproach) === "legacy"
      ? null
      : normalizeStoredFeedbackGenerationApproach(plan.generationApproach),
    generationApproachLabel: feedbackGenerationApproachLabel(plan.generationApproach),
    legacyReadonly: plan.generationApproach === "legacy",
    itemStatusCounts: generationProgress(plan.items),
    actionBucket: feedbackPlanActionBucket(plan.status, generationProgress(plan.items)),
    studentSummaries: plan.items.filter((item) => item.student).map((item) => ({ id: item.student!.id, name: item.student!.name, studentId: item.student!.studentId })),
  }));
}

export async function storedFeedbackPlanDraft(id: string, db: FeedbackPlanDb) {
  await assertFeedbackPlanAvailable(id, db);
  return db.feedbackPlan.findUnique({
    where: { id },
    select: {
      id: true,
      displayName: true,
      basedOnPlanId: true,
      type: true,
      outputRequirement: true,
      status: true,
      semesterId: true,
      classId: true,
      sessionId: true,
      rangeStartSessionId: true,
      rangeEndSessionId: true,
      inputFingerprint: true,
      inputSnapshot: true,
      generationMode: true,
      generationApproach: true,
      generationStartedAt: true,
      generationCompletedAt: true,
      planRevision: true,
      archivedAt: true,
      createdAt: true,
      batchId: true,
      batch: { select: { status: true, archivedAt: true } },
      session: { select: { code: true, date: true } },
      rangeEndSession: { select: { date: true } },
      items: {
        select: {
          id: true,
          studentId: true,
          status: true,
          evidenceSnapshot: true,
          generationConfigSnapshot: true,
          finalText: true,
          selectedGenerationId: true,
          approvedAt: true,
          exportedAt: true,
          student: {
            select: {
              name: true,
              studentId: true,
              communicationPreference: { select: { preferenceSnapshot: true } },
            },
          },
        },
      },
    },
  });
}
