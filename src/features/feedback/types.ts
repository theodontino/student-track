import type { FeedbackContextStudent } from "@/features/feedback/context-types";
import type { TeachingContext } from "@/features/teaching-context";
import type { AiWorkflowState } from "@/features/ai-workflow";
import type { DraftReviewResult, DraftStructuredResult, NameCorrection } from "@/lib/types";
import type { FeedbackReviewStatus } from "@/services/feedback-generation-service";
import type { FeedbackIntensity, FeedbackRoutingReason } from "@/lib/feedback-intensity";
import type { FeedbackOutputStrategy, FeedbackSections } from "@/lib/feedback-sections";
import type {
  AssessmentImportItem,
  LessonFeedbackMaterial,
  StudentAssessmentEvidence,
} from "@/lib/feedback-materials";

export interface FeedbackCard {
  id: string;
  name: string;
  labels: string[];
  feedback: string;
  draftFeedback?: string;
  reviewStatus?: FeedbackReviewStatus;
  reviewIssues?: string[];
  feedbackIntensity?: FeedbackIntensity;
  feedbackRoutingReasons?: FeedbackRoutingReason[];
  sections?: FeedbackSections;
}

export interface FeedbackContextResponse {
  session?: {
    id: string;
    code: string;
    date: string;
    semesterId: string;
    semesterNumber: number;
    classId: string;
  };
  className: string;
  total: number;
  students: FeedbackContextStudent[];
  routing?: Array<{
    studentId: string;
    baseline: Exclude<FeedbackIntensity, "manual">;
    intensity: FeedbackIntensity;
    reasons: FeedbackRoutingReason[];
  }>;
}

export interface BatchFeedbackHistoryState {
  kind: "batch";
  semesterId: string;
  sessionCode: string;
  className: string;
  students: FeedbackCard[];
  total: number;
  inputRevision?: string;
  batchStatus?: "completed" | "incomplete";
  batchPhase?: "draft" | "review" | "completed";
  completedStudentIds?: string[];
  failedStudentIds?: string[];
  interruptionReason?: string;
  lessonMaterial?: LessonFeedbackMaterial;
  assessmentEvidence?: Record<string, StudentAssessmentEvidence>;
  routingOverrides?: Record<string, FeedbackIntensity>;
  outputStrategy?: FeedbackOutputStrategy;
}

export interface SingleFeedbackHistoryState {
  kind: "single";
  semesterId: string;
  className: string;
  studentId: string;
  sessionCode: string;
  days: number;
  feedback: string;
  draftFeedback?: string;
  reviewStatus?: FeedbackReviewStatus;
  reviewIssues?: string[];
}

export type FeedbackHistoryState = BatchFeedbackHistoryState | SingleFeedbackHistoryState;

export interface FeedbackWorkspaceState {
  activeStep?: FeedbackStep;
  context: TeachingContext;
  newSessionDate: string;
  rawText: string;
  parseStatus: string;
  streamContent: string;
  draftId: string;
  parsedResult: DraftStructuredResult | null;
  reviewResult: DraftReviewResult | null;
  corrections: NameCorrection[];
  confirmed: boolean;
  status: string;
  feedbackCards: FeedbackCard[];
  feedbackTotal: number;
  feedbackDone: number;
  feedbackDirty: boolean;
  forceRegenerate: boolean;
  feedbackBatch?: FeedbackBatchProgress;
  singleStudentId: string;
  singleDays: number;
  singleFeedback: string;
  singleDraftFeedback?: string;
  singleReviewStatus?: FeedbackReviewStatus;
  singleReviewIssues?: string[];
  workflow?: AiWorkflowState;
  groupFeedbackRaw?: string;
  assessmentBriefRaw?: string;
  lessonMaterial?: LessonFeedbackMaterial;
  assessmentImports?: AssessmentImportItem[];
  routingOverrides?: Record<string, FeedbackIntensity>;
  outputStrategy?: FeedbackOutputStrategy;
}

export interface FeedbackBatchProgress {
  status: "idle" | "running" | "incomplete" | "completed" | "stale";
  phase: "idle" | "draft" | "review" | "completed";
  inputRevision: string;
  total: number;
  completedStudentIds: string[];
  failedStudentIds: string[];
  interruptionReason: string;
}

export interface FeedbackStudentOption {
  id: string;
  name: string;
  class: string;
  studentId?: string;
}

export type FeedbackStep = "prepare" | "extract" | "review" | "generate" | "export";
