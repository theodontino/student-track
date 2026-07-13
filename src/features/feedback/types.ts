import type { FeedbackContextStudent } from "@/components/wecom/types";
import type { TeachingContext } from "@/features/teaching-context";
import type { DraftReviewResult, DraftStructuredResult, NameCorrection } from "@/lib/types";

export interface FeedbackCard {
  id: string;
  name: string;
  labels: string[];
  feedback: string;
}

export interface FeedbackContextResponse {
  className: string;
  total: number;
  students: FeedbackContextStudent[];
}

export interface BatchFeedbackHistoryState {
  kind: "batch";
  semesterId: string;
  sessionCode: string;
  className: string;
  students: FeedbackCard[];
  total: number;
}

export interface SingleFeedbackHistoryState {
  kind: "single";
  semesterId: string;
  className: string;
  studentId: string;
  sessionCode: string;
  days: number;
  feedback: string;
}

export type FeedbackHistoryState = BatchFeedbackHistoryState | SingleFeedbackHistoryState;

export interface FeedbackWorkspaceState {
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
  singleStudentId: string;
  singleDays: number;
  singleFeedback: string;
}

export interface FeedbackStudentOption { id: string; name: string; class: string }
