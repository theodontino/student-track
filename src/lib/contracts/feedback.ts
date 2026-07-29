import { z } from "zod";
import type {
  AssessmentImportItem,
  LessonFeedbackMaterial,
  StudentAssessmentEvidence,
} from "@/lib/feedback-materials";
import type { FeedbackCard, FeedbackHistoryState, FeedbackWorkspaceState } from "@/features/feedback/types";
import {
  DraftReviewResultSchema,
  DraftStructuredResultSchema,
  NameCorrectionSchema,
} from "@/lib/contracts/classroom-parse";
import { FEEDBACK_INTENSITIES } from "@/lib/feedback-intensity";
import { FEEDBACK_LENGTHS, FEEDBACK_STYLES } from "@/lib/feedback-sections";

const text = (max: number) => z.string().max(max);
const requiredText = (max: number) => text(max).trim().min(1);
const count = z.number().int().min(0).max(10000);
const rate = z.number().finite().min(0).max(100);
const optionalRate = rate.nullable();

export const LessonFeedbackMaterialSchema: z.ZodType<LessonFeedbackMaterial> = z.object({
  version: z.literal(1),
  sessionCode: text(128).optional(),
  lessonSummary: text(2000).optional(),
  lessonSummarySourceHash: text(64).optional(),
  lessonSummaryStatus: z.enum(["model", "fallback"]).optional(),
  groupFeedbackRaw: text(100000),
  assessmentBriefRaw: text(100000),
  lessonTitle: text(2000),
  classroomContent: z.array(text(2000)).max(100),
  classroomFocus: z.array(text(2000)).max(100),
  classroomExplanation: z.array(text(2000)).max(100),
  homework: z.array(text(2000)).max(100),
  assessmentFocus: z.array(text(2000)).max(100),
  correctionAdvice: z.array(text(2000)).max(100),
  otherNotes: z.array(text(2000)).max(100),
});

export const StudentAssessmentEvidenceSchema: z.ZodType<StudentAssessmentEvidence> = z.object({
  sessionCode: text(128).optional(),
  studentId: text(200).optional(),
  reportTitle: text(2000),
  reportDate: text(128),
  totalQuestions: count,
  correctRate: rate,
  cohortAverageRate: optionalRate,
  knowledgePoints: z.array(z.object({
    name: requiredText(500),
    questionCount: count,
    correctRate: rate,
    cohortAverageRate: optionalRate,
  })).max(200),
  wrongItems: z.array(z.object({
    questionNumber: requiredText(100),
    studentAnswer: text(2000),
    correctAnswer: text(2000),
    knowledgePoints: z.array(requiredText(500)).max(50),
  })).max(1000),
  similarPracticeCount: count,
});

const assessmentEvidenceRecord = z.record(
  z.string().max(200),
  StudentAssessmentEvidenceSchema,
).refine((value) => Object.keys(value).length <= 200, {
  message: "assessmentEvidence cannot contain more than 200 students",
});

export const AssessmentImportItemSchema: z.ZodType<AssessmentImportItem> = z.object({
  id: requiredText(200),
  fileName: requiredText(1000),
  status: z.enum(["parsing", "matched", "needs_match", "confirmed", "error"]),
  reportStudentName: text(100),
  reportStudentId: text(200),
  matchedStudentId: text(200),
  matchedStudentName: text(100),
  evidence: StudentAssessmentEvidenceSchema.nullable(),
  error: text(2000),
});

const FeedbackSectionSchema = z.object({
  content: text(2000),
  evidence: z.array(z.object({
    source: z.enum(["current-session", "history", "assessment", "teaching-summary"]),
    label: text(500),
  })).max(8),
});

const FeedbackSectionsSchema = z.object({
  currentFact: FeedbackSectionSchema,
  flaggedIssue: FeedbackSectionSchema.optional(),
  trendChange: FeedbackSectionSchema.optional(),
  backgroundBaseline: FeedbackSectionSchema.optional(),
  renewalAlert: FeedbackSectionSchema.optional(),
  strategySuggestion: FeedbackSectionSchema.optional(),
});

export const FeedbackCardSchema: z.ZodType<FeedbackCard> = z.object({
  id: requiredText(200),
  name: requiredText(100),
  labels: z.array(text(200)).max(50),
  feedback: text(10000),
  draftFeedback: text(10000).optional(),
  reviewStatus: z.enum(["passed", "revised", "needs_review", "edited"]).optional(),
  reviewIssues: z.array(text(1000)).max(50).optional(),
  feedbackIntensity: z.enum(FEEDBACK_INTENSITIES).optional(),
  feedbackRoutingReasons: z.array(z.enum(["dashboard-warning", "dashboard-attention", "recent-teacher-observation"])).max(3).optional(),
  sections: FeedbackSectionsSchema.optional(),
});

export const FeedbackOutputStrategySchema = z.object({
  flaggedIssue: z.boolean(),
  trendChange: z.boolean(),
  backgroundBaseline: z.boolean(),
  strategySuggestion: z.boolean(),
  suggestedFeedback: z.boolean(),
  // Optional for 1.0 WorkHistory/workspace records. All server and UI callers
  // normalize missing values to balanced + standard before use.
  style: z.enum(FEEDBACK_STYLES).default("balanced"),
  length: z.enum(FEEDBACK_LENGTHS).default("standard"),
}).strict();

const historyCard = FeedbackCardSchema;
export const FeedbackBatchHistoryStateSchema = z.object({
  kind: z.literal("batch"),
  semesterId: requiredText(200),
  sessionCode: requiredText(128),
  className: requiredText(200),
  students: z.array(historyCard).max(200),
  total: count,
  inputRevision: text(64).optional(),
  batchStatus: z.enum(["completed", "incomplete"]).optional(),
  batchPhase: z.enum(["draft", "review", "completed"]).optional(),
  completedStudentIds: z.array(requiredText(200)).max(200).optional(),
  failedStudentIds: z.array(requiredText(200)).max(200).optional(),
  interruptionReason: text(2000).optional(),
  lessonMaterial: LessonFeedbackMaterialSchema.optional(),
  assessmentEvidence: assessmentEvidenceRecord.optional(),
  outputStrategy: FeedbackOutputStrategySchema.optional(),
}).passthrough();

export const FeedbackHistoryStateSchema: z.ZodType<FeedbackHistoryState> = z.discriminatedUnion("kind", [
  FeedbackBatchHistoryStateSchema,
  z.object({
    kind: z.literal("single"),
    semesterId: text(200),
    className: text(200),
    studentId: requiredText(200),
    sessionCode: text(128),
    days: z.number().int().min(1).max(365),
    feedback: text(10000),
    draftFeedback: text(10000).optional(),
    reviewStatus: z.enum(["passed", "revised", "needs_review", "edited"]).optional(),
    reviewIssues: z.array(text(1000)).max(50).optional(),
  }),
]);

export const FeedbackBatchJsonResponseSchema = FeedbackBatchHistoryStateSchema.extend({
  cached: z.boolean().optional(),
  saved: z.boolean().optional(),
});

export const FeedbackSingleResponseSchema = z.object({
  feedback: text(10000).optional(),
  draftFeedback: text(10000).optional(),
  reviewStatus: z.enum(["passed", "revised", "needs_review", "edited"]).optional(),
  reviewIssues: z.array(text(1000)).max(50).optional(),
  lessonMaterial: LessonFeedbackMaterialSchema.optional(),
}).passthrough();

const AiWorkflowStateSchema = z.union([
  z.object({ phase: z.literal("idle"), operation: z.literal(""), message: z.literal(""), updatedAt: z.literal("") }),
  z.object({ phase: z.enum(["validating", "generating", "reviewing", "saving"]), operation: requiredText(200), message: text(2000), updatedAt: requiredText(100), startedAt: requiredText(100), progress: z.number().min(0).max(1).nullable() }),
  z.object({ phase: z.literal("completed"), operation: requiredText(200), message: text(2000), updatedAt: requiredText(100), startedAt: requiredText(100), completedAt: requiredText(100) }),
  z.object({ phase: z.literal("failed"), operation: requiredText(200), message: text(2000), updatedAt: requiredText(100), startedAt: requiredText(100), error: requiredText(2000), retryPhase: z.enum(["validating", "generating", "reviewing", "saving"]) }),
  z.object({ phase: z.literal("cancelled"), operation: requiredText(200), message: text(2000), updatedAt: requiredText(100), startedAt: requiredText(100), cancelledAt: requiredText(100) }),
]);

export const FeedbackWorkspaceSchema: z.ZodType<FeedbackWorkspaceState> = z.object({
  activeStep: z.enum(["prepare", "extract", "review", "generate", "export"]).optional(),
  context: z.object({
    semesterId: text(200),
    className: text(200),
    sessionCode: text(128),
  }),
  newSessionDate: text(32),
  rawText: text(100000),
  parseStatus: text(2000),
  streamContent: text(100000),
  draftId: text(200),
  parsedResult: DraftStructuredResultSchema.nullable(),
  reviewResult: DraftReviewResultSchema.nullable(),
  corrections: z.array(NameCorrectionSchema).max(100),
  confirmed: z.boolean(),
  status: text(2000),
  feedbackCards: z.array(FeedbackCardSchema).max(200),
  feedbackTotal: count,
  feedbackDone: count,
  feedbackDirty: z.boolean(),
  forceRegenerate: z.boolean(),
  feedbackBatch: z.object({
    status: z.enum(["idle", "running", "incomplete", "completed", "stale"]),
    phase: z.enum(["idle", "draft", "review", "completed"]),
    inputRevision: text(64),
    total: count,
    completedStudentIds: z.array(requiredText(200)).max(200),
    failedStudentIds: z.array(requiredText(200)).max(200),
    interruptionReason: text(2000),
  }).optional(),
  singleStudentId: text(200),
  singleDays: z.number().int().min(1).max(365),
  singleFeedback: text(10000),
  singleDraftFeedback: text(10000).optional(),
  singleReviewStatus: z.enum(["passed", "revised", "needs_review"]).optional(),
  singleReviewIssues: z.array(text(1000)).max(50).optional(),
  workflow: AiWorkflowStateSchema.optional(),
  groupFeedbackRaw: text(100000).optional(),
  assessmentBriefRaw: text(100000).optional(),
  lessonMaterial: LessonFeedbackMaterialSchema.optional(),
  assessmentImports: z.array(AssessmentImportItemSchema).max(200).optional(),
  routingOverrides: z.record(z.string().max(200), z.enum(FEEDBACK_INTENSITIES)).optional(),
  outputStrategy: FeedbackOutputStrategySchema.optional(),
}).passthrough().refine((value) => value.feedbackDone <= value.feedbackTotal, {
  message: "feedbackDone cannot exceed feedbackTotal",
  path: ["feedbackDone"],
});

export const FeedbackBatchPostSchema = z.object({
  sessionCode: requiredText(128),
  historyModule: z.enum(["feedback", "report"]).optional(),
  bypassCache: z.boolean().optional(),
  saveState: z.boolean().optional(),
  savePartial: z.boolean().optional(),
  revisionOnly: z.boolean().optional(),
  inputRevision: text(64).optional(),
  completedStudentIds: z.array(requiredText(200)).max(200).optional(),
  failedStudentIds: z.array(requiredText(200)).max(200).optional(),
  interruptionReason: text(2000).optional(),
  lessonMaterial: LessonFeedbackMaterialSchema.optional(),
  assessmentEvidence: assessmentEvidenceRecord.optional(),
  routingOverrides: z.record(z.string().max(200), z.enum(FEEDBACK_INTENSITIES)).optional(),
  outputStrategy: FeedbackOutputStrategySchema.optional(),
  // 前端 saveFeedbackState 直接传入 feedbackCards，包含 name/labels 等展示字段；
  // name/labels 都设为可选，且不使用 strict 模式，避免拒绝前端展示字段。
  students: z.array(z.object({
    id: requiredText(200),
    name: text(100).optional(),
    labels: z.array(text(200)).max(50).optional(),
    feedback: text(10000),
    draftFeedback: text(10000).optional(),
    reviewStatus: z.enum(["passed", "revised", "needs_review", "edited"]).optional(),
    reviewIssues: z.array(text(1000)).max(50).optional(),
    feedbackIntensity: z.enum(FEEDBACK_INTENSITIES).optional(),
    feedbackRoutingReasons: z.array(z.enum(["dashboard-warning", "dashboard-attention", "recent-teacher-observation"])).max(3).optional(),
    sections: FeedbackSectionsSchema.optional(),
  })).max(200).optional(),
}).passthrough().superRefine((value, context) => {
  if (value.savePartial && !value.saveState) {
    context.addIssue({ code: "custom", message: "savePartial requires saveState", path: ["savePartial"] });
  }
  if (value.revisionOnly && value.saveState) {
    context.addIssue({ code: "custom", message: "revisionOnly cannot save state", path: ["revisionOnly"] });
  }
});

export const FeedbackBatchStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("init"), students: z.array(FeedbackCardSchema).max(200), total: count, inputRevision: requiredText(64) }),
  z.object({ type: z.literal("draft"), studentId: requiredText(200), name: requiredText(100), feedback: text(10000), draftFeedback: text(10000).optional(), reviewStatus: z.enum(["passed", "revised", "needs_review", "edited"]).optional(), reviewIssues: z.array(text(1000)).max(50).optional(), completed: count, total: count }),
  z.object({ type: z.literal("review"), studentId: requiredText(200), name: requiredText(100), feedback: text(10000), draftFeedback: text(10000).optional(), reviewStatus: z.enum(["passed", "revised", "needs_review", "edited"]).optional(), reviewIssues: z.array(text(1000)).max(50).optional(), completed: count, total: count }),
  FeedbackBatchHistoryStateSchema.extend({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: requiredText(2000), code: text(80).optional(), retryable: z.boolean().optional(), diagnosticId: text(100).optional() }),
]);

export type FeedbackBatchStreamEvent = z.infer<typeof FeedbackBatchStreamEventSchema>;
