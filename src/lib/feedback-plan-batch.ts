import { z } from "zod";
import {
  FeedbackGenerationPreferencesSchema,
  FeedbackPlanAssessmentEvidenceSchema,
  FeedbackPlanStudentOverrideSchema,
} from "@/lib/feedback-plan";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";

export const FEEDBACK_PLAN_BATCH_STATUSES = [
  "ready",
  "queued",
  "running",
  "pause_requested",
  "paused",
  "failed",
  "completed",
  "archived",
] as const;

export const FeedbackPlanBatchChildSchema = z.object({
  classId: z.string().trim().min(1).max(200),
  sessionId: z.string().trim().min(1).max(200).optional(),
  rangeStartSessionId: z.string().trim().min(1).max(200).optional(),
  rangeEndSessionId: z.string().trim().min(1).max(200).optional(),
  studentIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  assessmentEvidence: FeedbackPlanAssessmentEvidenceSchema.optional(),
  lessonMaterial: LessonFeedbackMaterialSchema.optional(),
  generationPreferences: FeedbackGenerationPreferencesSchema.optional(),
  studentOverrides: z.array(FeedbackPlanStudentOverrideSchema).max(200).optional(),
});

export const FeedbackPlanBatchCreateSchema = z.object({
  requestKey: z.string().trim().min(8).max(200),
  semesterId: z.string().trim().min(1).max(200),
  type: z.enum(["event_micro", "stage_trend"]),
  outputRequirement: z.string().trim().min(1).max(2000),
  generationMode: z.enum(["standard", "fast"]).default("standard"),
  sharedLessonRevisionId: z.string().trim().min(1).max(200).optional(),
  sharedMaterialConfirmed: z.boolean().optional(),
  plans: z.array(FeedbackPlanBatchChildSchema).min(2).max(20),
}).superRefine((value, ctx) => {
  const classIds = new Set<string>();
  value.plans.forEach((plan, index) => {
    if (classIds.has(plan.classId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["plans", index, "classId"], message: "同一班级不能在批次中重复" });
    }
    classIds.add(plan.classId);
  });
  if (value.sharedLessonRevisionId && value.sharedMaterialConfirmed !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sharedMaterialConfirmed"], message: "使用共同课修订前必须由教师明确确认" });
  }
});

export type FeedbackPlanBatchCreateInput = z.input<typeof FeedbackPlanBatchCreateSchema>;

export const FeedbackPlanBatchActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("continue") }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("archive") }),
  z.object({ action: z.literal("export"), mode: z.enum(["approved_only", "complete"]).default("approved_only"), allowRepeat: z.boolean().optional() }),
]);

export type FeedbackPlanBatchAction = z.infer<typeof FeedbackPlanBatchActionSchema>;
