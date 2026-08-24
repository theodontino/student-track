import type { FeedbackClosureType } from "@/lib/feedback-plan";

export type TaskStage = "prepare" | "confirm" | "studio";
export type MaterialSelection = { mode: "none" } | { mode: "session_snapshot" } | { mode: "linked_revision"; revisionId: string };

export type FeedbackTaskClassDraft = {
  classId: string;
  classCode: string;
  className: string;
  sessionCode: string;
  runId: string;
  studentIds: string[];
  selected: boolean;
};

export type FeedbackTaskDraftV2 = {
  version: 2;
  mode: "single" | "group";
  groupLessonId: string;
  activeSessionCode: string;
  entries: FeedbackTaskClassDraft[];
  materialSelection: MaterialSelection;
  generationMode: "standard" | "fast";
  outputRequirement: string;
  preferences: {
    length: "inherit" | "short" | "standard" | "detailed";
    tone: "inherit" | "gentle" | "professional";
    closureType: FeedbackClosureType;
    moduleKeys: string[];
  };
};

export type FeedbackTaskState = {
  stage: TaskStage;
  draft: FeedbackTaskDraftV2;
  planId: string;
  batchId: string;
};

export type FeedbackTaskAction =
  | { type: "draft"; patch: Partial<FeedbackTaskDraftV2> }
  | { type: "entries"; entries: FeedbackTaskClassDraft[] }
  | { type: "entry"; sessionCode: string; patch: Partial<FeedbackTaskClassDraft> }
  | { type: "stage"; stage: TaskStage }
  | { type: "task"; planId?: string; batchId?: string }
  | { type: "restore"; draft: FeedbackTaskDraftV2 };

export function createFeedbackTaskDraft(): FeedbackTaskDraftV2 {
  return {
    version: 2,
    mode: "single",
    groupLessonId: "",
    activeSessionCode: "",
    entries: [],
    materialSelection: { mode: "none" },
    generationMode: "standard",
    outputRequirement: "为每名入选学生生成一条可复核的家长反馈",
    preferences: { length: "inherit", tone: "inherit", closureType: "positive_recognition", moduleKeys: ["observed_moment", "teacher_interpretation"] },
  };
}

export function feedbackTaskReducer(state: FeedbackTaskState, action: FeedbackTaskAction): FeedbackTaskState {
  if (action.type === "draft") return { ...state, draft: { ...state.draft, ...action.patch } };
  if (action.type === "entries") return { ...state, draft: { ...state.draft, entries: action.entries } };
  if (action.type === "entry") return { ...state, draft: { ...state.draft, entries: state.draft.entries.map((entry) => entry.sessionCode === action.sessionCode ? { ...entry, ...action.patch } : entry) } };
  if (action.type === "stage") return { ...state, stage: action.stage };
  if (action.type === "task") return { ...state, stage: "studio", planId: action.planId ?? state.planId, batchId: action.batchId ?? state.batchId };
  if (action.type === "restore") return { ...state, draft: action.draft };
  return state;
}

export function activeTaskEntry(state: FeedbackTaskState) {
  return state.draft.entries.find((entry) => entry.sessionCode === state.draft.activeSessionCode) ?? state.draft.entries[0] ?? null;
}
