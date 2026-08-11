import { z } from "zod";
import { ATTENTION_REASONS } from "@/lib/attention-labels";
import type {
  DraftReviewResult,
  DraftStructuredResult,
  NameCorrection,
  TeacherIntervention,
} from "@/lib/types";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const optionalBoundedText = (max: number) => z.string().trim().max(max).optional();
const interventionText = (max: number) => z.string().trim().max(max).default("");
const score = z.number().int().min(0).max(5).nullable();

export const AttentionSignalCandidateSchema = z.object({
  reason: z.enum(ATTENTION_REASONS),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceSummary: boundedText(240),
});

export const TeacherInterventionSchema: z.ZodType<TeacherIntervention> = z.object({
  // A teacher observation is useful evidence even when it has not yet been
  // expanded into a complete problem/action/outcome narrative. Missing parts
  // stay empty rather than causing the whole observation to disappear.
  observedProblem: interventionText(1000),
  teacherAction: interventionText(1000),
  outcome: interventionText(1000),
  evidenceText: interventionText(2000),
}).refine((value) => Boolean(value.observedProblem || value.teacherAction || value.outcome || value.evidenceText), {
  message: "教师观察至少需要一项内容",
});

export const DraftStudentSchema = z.object({
  name: boundedText(100),
  studentId: optionalBoundedText(128),
  scores: z.object({ A: score, B: score, C: score }),
  events: z.array(boundedText(1000)).max(50),
  communication: z.object({
    type: boundedText(100),
    summary: boundedText(5000),
    occurredAt: optionalBoundedText(64),
  }).nullable(),
  present: z.boolean().optional(),
  attentionSignals: z.array(AttentionSignalCandidateSchema).max(4).optional(),
  teacherInterventions: z.array(TeacherInterventionSchema).max(20).optional(),
});

export const DraftStructuredResultSchema: z.ZodType<DraftStructuredResult> = z.object({
  students: z.array(DraftStudentSchema).max(200),
  alert_suggestion: z.string().trim().max(2000),
});

export const DraftReviewResultSchema: z.ZodType<DraftReviewResult> = z.object({
  is_valid: z.boolean(),
  issues: z.array(boundedText(1000)).max(50),
  suggestions: z.array(boundedText(1000)).max(50),
  revised_scores: z.record(z.string().max(100), z.record(z.string().max(10), score)).default({}),
  revised_events: z.record(z.string().max(100), z.array(boundedText(1000)).max(50)).default({}),
  revised_teacher_interventions: z.record(
    z.string().max(100),
    z.array(TeacherInterventionSchema).max(20),
  ).default({}),
});

export const NameCorrectionSchema: z.ZodType<NameCorrection> = z.object({
  original: boundedText(100),
  corrected: boundedText(100),
  confidence: z.enum(["high", "medium", "low"]),
  reason: optionalBoundedText(500),
});

export const NameFixPayloadSchema = z.object({
  corrections: z.array(NameCorrectionSchema).max(100),
  correctedText: z.string().max(100000).optional(),
});

export const ParseRequestSchema = z.object({
  rawText: z.string().trim().min(1).max(300000),
  sessionCode: z.string().trim().min(1).max(128),
});

const streamError = z.object({
  type: z.literal("error"),
  message: boundedText(2000),
  code: z.string().max(80).optional(),
  retryable: z.boolean().optional(),
  diagnosticId: z.string().max(100).optional(),
  warnings: z.array(boundedText(500)).max(20).optional(),
});

export const ParseStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), message: boundedText(1000) }),
  z.object({ type: z.literal("chunk"), content: z.string().max(10000) }),
  z.object({
    type: z.literal("result"),
    draftId: boundedText(200),
    parsedResult: DraftStructuredResultSchema,
    reviewResult: DraftReviewResultSchema.nullable(),
    corrections: z.array(NameCorrectionSchema).max(100),
    warnings: z.array(boundedText(500)).max(20).optional(),
  }),
  streamError,
]);

export type ParseRequest = z.infer<typeof ParseRequestSchema>;
export type ParseStreamEvent = z.infer<typeof ParseStreamEventSchema>;
