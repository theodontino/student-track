import type { FeedbackStep } from "./types";
import type { DraftReviewResult, DraftStructuredResult, NameCorrection, TeacherIntervention } from "@/lib/types";
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
  groupFeedbackRaw: string;
  assessmentBriefRaw: string;
  lessonMaterial: LessonFeedbackMaterial;
}

export type FeedbackWorkspaceCoreAction =
  | { type: "patch"; patch: Partial<FeedbackWorkspaceCoreState> }
  | { type: "stream/append"; content: string }
  | { type: "parsed/attendance"; index: number; present: boolean }
  | { type: "parsed/teacher-interventions"; index: number; interventions: TeacherIntervention[] };

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
        confirmed: false,
        status: "结构化记录已修改，请重新确认写入后再创建反馈计划。",
        parsedResult: state.parsedResult
          ? {
            ...state.parsedResult,
            students: state.parsedResult.students.map((student, index) =>
              index === action.index ? { ...student, present: action.present } : student),
          }
          : null,
      };
    case "parsed/teacher-interventions":
      return {
        ...state,
        confirmed: false,
        status: "结构化记录已修改，请重新确认写入后再创建反馈计划。",
        parsedResult: state.parsedResult
          ? {
            ...state.parsedResult,
            students: state.parsedResult.students.map((student, index) =>
              index === action.index
                ? { ...student, teacherInterventions: action.interventions }
                : student),
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
    groupFeedbackRaw: "",
    assessmentBriefRaw: "",
    lessonMaterial: createEmptyLessonFeedbackMaterial(),
  };
}
