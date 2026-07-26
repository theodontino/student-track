import type { FeedbackCard, FeedbackStep } from "./types";
import type { DraftReviewResult, DraftStructuredResult, NameCorrection } from "@/lib/types";
import type { FeedbackReviewStatus } from "@/services/feedback-generation-service";
import {
  createEmptyLessonFeedbackMaterial,
  type LessonFeedbackMaterial,
} from "@/lib/feedback-materials";

export interface FeedbackWorkspaceCoreState {
  activeStep: FeedbackStep;
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
  singleStudentId: string;
  singleDays: number;
  singleFeedback: string;
  singleDraftFeedback: string;
  singleReviewStatus?: FeedbackReviewStatus;
  singleReviewIssues: string[];
  groupFeedbackRaw: string;
  assessmentBriefRaw: string;
  lessonMaterial: LessonFeedbackMaterial;
}

export type FeedbackWorkspaceCoreAction =
  | { type: "patch"; patch: Partial<FeedbackWorkspaceCoreState> }
  | { type: "stream/append"; content: string }
  | { type: "parsed/attendance"; index: number; present: boolean };

export interface FeedbackCardsState {
  cards: FeedbackCard[];
  total: number;
  done: number;
  dirty: boolean;
  forceRegenerate: boolean;
}

export type FeedbackCardsAction =
  | { type: "reset"; forceRegenerate?: boolean }
  | { type: "init"; cards: FeedbackCard[]; total: number; done?: number }
  | { type: "patch"; studentId: string; patch: Partial<FeedbackCard> }
  | { type: "progress"; done: number }
  | { type: "dirty"; value: boolean }
  | { type: "force"; value: boolean };

export function feedbackCardsReducer(state: FeedbackCardsState, action: FeedbackCardsAction): FeedbackCardsState {
  switch (action.type) {
    case "reset": return { cards: [], total: 0, done: 0, dirty: false, forceRegenerate: action.forceRegenerate ?? false };
    case "init": return { ...state, cards: action.cards, total: action.total, done: action.done ?? 0, dirty: false };
    case "patch": return { ...state, cards: state.cards.map((card) => card.id === action.studentId ? { ...card, ...action.patch } : card) };
    case "progress": return { ...state, done: Math.max(0, Math.min(action.done, state.total)) };
    case "dirty": return { ...state, dirty: action.value };
    case "force": return { ...state, forceRegenerate: action.value };
    default: return state;
  }
}

export function feedbackWorkspaceCoreReducer(
  state: FeedbackWorkspaceCoreState,
  action: FeedbackWorkspaceCoreAction,
): FeedbackWorkspaceCoreState {
  switch (action.type) {
    case "patch":
      return { ...state, ...action.patch };
    case "stream/append":
      return { ...state, streamContent: state.streamContent + action.content };
    case "parsed/attendance":
      return {
        ...state,
        parsedResult: state.parsedResult
          ? {
            ...state.parsedResult,
            students: state.parsedResult.students.map((student, index) =>
              index === action.index ? { ...student, present: action.present } : student),
          }
          : null,
      };
    default: return state;
  }
}

export function createFeedbackWorkspaceCoreState(
  activeStep: FeedbackStep = "prepare",
): FeedbackWorkspaceCoreState {
  return {
    activeStep,
    newSessionDate: "",
    rawText: "",
    parseStatus: "",
    streamContent: "",
    draftId: "",
    parsedResult: null,
    reviewResult: null,
    corrections: [],
    confirmed: false,
    status: "",
    singleStudentId: "",
    singleDays: 14,
    singleFeedback: "",
    singleDraftFeedback: "",
    singleReviewIssues: [],
    groupFeedbackRaw: "",
    assessmentBriefRaw: "",
    lessonMaterial: createEmptyLessonFeedbackMaterial(),
  };
}
