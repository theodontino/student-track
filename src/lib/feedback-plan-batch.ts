import { z } from "zod";
import {
  FeedbackGenerationPreferencesSchema,
  FeedbackPlanAssessmentEvidenceSchema,
  FeedbackPlanStudentOverrideSchema,
} from "@/lib/feedback-plan";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";

export const FEEDBACK_PLAN_BATCH_STATUSES = [
  "draft",
  "ready",
  "queued",
  "running",
  "pause_requested",
  "paused",
  "failed",
  "completed",
  "archived",
] as const;

const FeedbackProjectNameSchema = z.string().trim().min(1).max(120);

export const FeedbackPlanBatchChildSchema = z.object({
  classId: z.string().trim().min(1).max(200),
  intakeRunId: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(200).optional(),
  rangeStartSessionId: z.string().trim().min(1).max(200).optional(),
  rangeEndSessionId: z.string().trim().min(1).max(200).optional(),
  studentIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  assessmentEvidence: FeedbackPlanAssessmentEvidenceSchema.optional(),
  lessonMaterial: LessonFeedbackMaterialSchema.optional(),
  outputRequirement: z.string().trim().min(1).max(2000).optional(),
  generationPreferences: FeedbackGenerationPreferencesSchema.optional(),
  studentOverrides: z.array(FeedbackPlanStudentOverrideSchema).max(200).superRefine((overrides, ctx) => {
    const ids = new Set<string>();
    overrides.forEach((override, index) => {
      if (ids.has(override.studentId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "studentId"], message: "同一学生不能重复设置独立计划" });
      }
      ids.add(override.studentId);
    });
  }).optional(),
});

export const FeedbackPlanBatchCreateSchema = z.object({
  requestKey: z.string().trim().min(8).max(200),
  displayName: FeedbackProjectNameSchema.optional(),
  basedOnBatchId: z.string().trim().min(1).max(200).optional(),
  semesterId: z.string().trim().min(1).max(200),
  type: z.enum(["event_micro", "stage_trend"]),
  outputRequirement: z.string().trim().min(1).max(2000),
  generationMode: z.enum(["standard", "fast"]).default("standard"),
  generationPreferences: FeedbackGenerationPreferencesSchema.optional(),
  groupLessonId: z.string().trim().min(1).max(200).optional(),
  sharedLessonRevisionId: z.string().trim().min(1).max(200).optional(),
  sharedMaterialConfirmed: z.boolean().optional(),
  plans: z.array(FeedbackPlanBatchChildSchema).min(1).max(20),
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

const FeedbackPlanBatchClassOverrideSchema = z.object({
  classId: z.string().trim().min(1).max(200),
  outputRequirement: z.string().trim().min(1).max(2000).optional(),
  generationPreferences: FeedbackGenerationPreferencesSchema.optional(),
}).refine((value) => Boolean(value.outputRequirement || value.generationPreferences), {
  message: "班级例外至少需要修改一项反馈要求",
});

const FeedbackPlanBatchStudentSelectionSchema = z.object({
  classId: z.string().trim().min(1).max(200),
  studentIds: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
}).superRefine((value, ctx) => {
  const studentIds = new Set<string>();
  value.studentIds.forEach((studentId, index) => {
    if (studentIds.has(studentId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["studentIds", index], message: "同一班级不能重复选择学生" });
    }
    studentIds.add(studentId);
  });
});

export const FeedbackPlanBatchDraftPatchSchema = z.object({
  action: z.literal("plan_draft"),
  expectedPlanRevision: z.number().int().positive(),
  displayName: FeedbackProjectNameSchema.optional(),
  outputRequirement: z.string().trim().min(1).max(2000),
  generationMode: z.enum(["standard", "fast"]),
  generationPreferences: FeedbackGenerationPreferencesSchema,
  studentSelections: z.array(FeedbackPlanBatchStudentSelectionSchema).min(1).max(20),
  classOverrides: z.array(FeedbackPlanBatchClassOverrideSchema).max(20).default([]),
  studentOverrides: z.array(FeedbackPlanStudentOverrideSchema).max(200).default([]),
}).superRefine((value, ctx) => {
  const selectionClassIds = new Set<string>();
  value.studentSelections.forEach((selection, index) => {
    if (selectionClassIds.has(selection.classId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["studentSelections", index, "classId"], message: "同一班级只能提交一份学生范围" });
    }
    selectionClassIds.add(selection.classId);
  });
  const classIds = new Set<string>();
  value.classOverrides.forEach((override, index) => {
    if (classIds.has(override.classId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["classOverrides", index, "classId"], message: "同一班级不能重复设置例外" });
    }
    classIds.add(override.classId);
  });
  const studentIds = new Set<string>();
  value.studentOverrides.forEach((override, index) => {
    if (studentIds.has(override.studentId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["studentOverrides", index, "studentId"], message: "同一学生不能重复设置独立计划" });
    }
    studentIds.add(override.studentId);
  });
});

export const FeedbackPlanBatchRenameSchema = z.object({
  action: z.literal("rename"),
  displayName: FeedbackProjectNameSchema,
  expectedPlanRevision: z.number().int().positive().optional(),
});

export const FeedbackPlanBatchPatchSchema = z.discriminatedUnion("action", [
  FeedbackPlanBatchDraftPatchSchema,
  FeedbackPlanBatchRenameSchema,
]);

export type FeedbackPlanBatchDraftPatch = z.infer<typeof FeedbackPlanBatchDraftPatchSchema>;
export type FeedbackPlanBatchRename = z.infer<typeof FeedbackPlanBatchRenameSchema>;

export const FeedbackPlanBatchActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), expectedPlanRevision: z.number().int().positive().optional() }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("continue") }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("archive") }),
  z.object({ action: z.literal("unarchive") }),
  z.object({ action: z.literal("clone_draft"), displayName: FeedbackProjectNameSchema.optional() }),
  z.object({ action: z.literal("save_as"), displayName: FeedbackProjectNameSchema, patch: z.unknown() }),
  z.object({ action: z.literal("export"), mode: z.enum(["approved_only", "complete"]).default("approved_only"), allowRepeat: z.boolean().optional() }),
]);

export type FeedbackPlanBatchAction = z.infer<typeof FeedbackPlanBatchActionSchema>;
