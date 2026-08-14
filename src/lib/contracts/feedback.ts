import { z } from "zod";
import type {
  AssessmentImportItem,
  LessonFeedbackMaterial,
  StudentAssessmentEvidence,
} from "@/lib/feedback-materials";
import {
  DraftReviewResultSchema,
  DraftStructuredResultSchema,
  NameCorrectionSchema,
} from "@/lib/contracts/classroom-parse";

const text = (max: number) => z.string().max(max);
const requiredText = (max: number) => text(max).trim().min(1);
const count = z.number().int().min(0).max(10000);
const rate = z.number().finite().min(0).max(100);
const optionalRate = rate.nullable();

export const LessonFeedbackMaterialSchema: z.ZodType<LessonFeedbackMaterial> = z.object({
  version: z.literal(1),
  sessionCode: text(128).optional(),
  scriptLessonNumber: z.number().int().min(1).max(1000).optional(),
  semesterScriptSource: z.object({
    lessonNumber: z.number().int().min(1).max(1000),
    libraryUpdatedAt: requiredText(100),
  }).optional(),
  perfectPrivateTemplate: text(100000).optional(),
  errorPrivateTemplate: text(100000).optional(),
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
  sourceType: z.enum(["assessment_pdf", "classroom_practice"]).optional(),
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

export const AssessmentEvidenceRecordSchema = z.record(
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

const AiWorkflowStateSchema = z.union([
  z.object({ phase: z.literal("idle"), operation: z.literal(""), message: z.literal(""), updatedAt: z.literal("") }),
  z.object({ phase: z.enum(["validating", "generating", "reviewing", "saving"]), operation: requiredText(200), message: text(2000), updatedAt: requiredText(100), startedAt: requiredText(100), progress: z.number().min(0).max(1).nullable() }),
  z.object({ phase: z.literal("completed"), operation: requiredText(200), message: text(2000), updatedAt: requiredText(100), startedAt: requiredText(100), completedAt: requiredText(100) }),
  z.object({ phase: z.literal("failed"), operation: requiredText(200), message: text(2000), updatedAt: requiredText(100), startedAt: requiredText(100), error: requiredText(2000), retryPhase: z.enum(["validating", "generating", "reviewing", "saving"]) }),
  z.object({ phase: z.literal("cancelled"), operation: requiredText(200), message: text(2000), updatedAt: requiredText(100), startedAt: requiredText(100), cancelledAt: requiredText(100) }),
]);

// This is intentionally only the current tab's unsubmitted workspace. Durable
// feedback history lives in FeedbackPlan; no old batch/single history shape is
// accepted here.
export const FeedbackWorkspaceSchema = z.object({
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
  workflow: AiWorkflowStateSchema.optional(),
  groupFeedbackRaw: text(100000).optional(),
  assessmentBriefRaw: text(100000).optional(),
  lessonMaterial: LessonFeedbackMaterialSchema.optional(),
  assessmentImports: z.array(AssessmentImportItemSchema).max(200).optional(),
}).passthrough();
