import type {
  FeedbackClosureType,
  FeedbackGenerationPreferences,
  FeedbackPlanItemGenerationConfig,
} from "@/lib/feedback-plan";
import type { FeedbackGroupIntakeUnassigned } from "./feedback-task-types";

export type TaskStage = "prepare" | "confirm" | "studio";
export type MaterialSelection = { mode: "none" } | { mode: "session_snapshot" } | { mode: "linked_revision"; revisionId: string };

export type ResolvedFeedbackTaskMaterialChoice = {
  value: string;
  historicalLabel?: string;
};

export type FeedbackTaskPreferences = FeedbackGenerationPreferences & {
  length: "inherit" | "short" | "standard" | "detailed";
  tone: "inherit" | "gentle" | "professional";
  closureType: FeedbackClosureType;
};

export type FeedbackTaskClassOverrideDraft = {
  sessionCode: string;
  outputRequirement?: string;
  preferences?: Partial<FeedbackTaskPreferences>;
};

export type FeedbackTaskStudentOverrideDraft = {
  studentId: string;
  generationConfig: FeedbackPlanItemGenerationConfig;
};

export type FeedbackTaskClassDraft = {
  classId: string;
  classCode: string;
  className: string;
  sessionCode: string;
  runId: string;
  studentIds: string[];
  /** false 表示仍由推荐规则维护；教师明确调整后设为 true，后续材料不再覆盖。 */
  studentSelectionInitialized: boolean;
  selected: boolean;
};

export type FeedbackTaskGroupSnapshot = {
  groupLessonId: string;
  activeSessionCode: string;
  entries: FeedbackTaskClassDraft[];
  /** 已成功建立反馈任务的课次；用于后续批次保留账本但禁止重复纳入。 */
  plannedSessionCodes: string[];
  unassignedSourceCount: number;
  unassignedSources: FeedbackGroupIntakeUnassigned[];
};

export type FeedbackTaskDraftV2 = {
  version: 2;
  setupStage: "prepare" | "confirm";
  requestKey: string;
  mode: "single" | "group";
  groupLessonId: string;
  activeSessionCode: string;
  entries: FeedbackTaskClassDraft[];
  /** 已成功建立反馈任务的课次；用于后续批次保留账本但禁止重复纳入。 */
  plannedSessionCodes: string[];
  materialSelection: MaterialSelection;
  materialSelectionInitialized: boolean;
  pendingMaterialLessonNumber: number | null;
  generationMode: "standard" | "fast";
  outputRequirement: string;
  preferences: FeedbackTaskPreferences;
  classOverrides: FeedbackTaskClassOverrideDraft[];
  studentOverrides: FeedbackTaskStudentOverrideDraft[];
  unassignedSourceCount: number;
  /** 未归属材料的班级候选账本；用于部分班级后续继续处理。 */
  unassignedSources: FeedbackGroupIntakeUnassigned[];
  groupSnapshot: FeedbackTaskGroupSnapshot | null;
};

export function resolveFeedbackTaskMaterialChoice(
  draft: Pick<FeedbackTaskDraftV2, "materialSelection" | "pendingMaterialLessonNumber">,
  availableMaterial: MaterialSelection | null,
): ResolvedFeedbackTaskMaterialChoice {
  if (draft.pendingMaterialLessonNumber) return { value: `library:${draft.pendingMaterialLessonNumber}` };
  if (draft.materialSelection.mode === "none") return { value: "none" };
  if (draft.materialSelection.mode === "session_snapshot") {
    return availableMaterial?.mode === "session_snapshot"
      ? { value: "current" }
      : { value: "draft:session_snapshot", historicalLabel: "使用草稿中保存的课次材料（当前不可预览）" };
  }
  return availableMaterial?.mode === "linked_revision" && availableMaterial.revisionId === draft.materialSelection.revisionId
    ? { value: "current" }
    : { value: `draft:linked_revision:${draft.materialSelection.revisionId}`, historicalLabel: "使用草稿中保存的历史共同课修订（当前不可预览）" };
}

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
  | { type: "class-override"; sessionCode: string; override: Omit<FeedbackTaskClassOverrideDraft, "sessionCode"> | null }
  | { type: "student-override"; studentId: string; generationConfig: FeedbackPlanItemGenerationConfig | null }
  | { type: "stage"; stage: TaskStage }
  | { type: "task"; planId?: string; batchId?: string }
  | { type: "restore"; draft: FeedbackTaskDraftV2 };

export function createFeedbackTaskDraft(): FeedbackTaskDraftV2 {
  return {
    version: 2,
    setupStage: "prepare",
    requestKey: crypto.randomUUID(),
    mode: "single",
    groupLessonId: "",
    activeSessionCode: "",
    entries: [],
    plannedSessionCodes: [],
    materialSelection: { mode: "none" },
    materialSelectionInitialized: false,
    pendingMaterialLessonNumber: null,
    generationMode: "standard",
    outputRequirement: "为每名入选学生生成一条可复核的家长反馈",
    preferences: { length: "inherit", tone: "inherit", closureType: "positive_recognition", moduleKeys: ["observed_moment", "teacher_interpretation"] },
    classOverrides: [],
    studentOverrides: [],
    unassignedSourceCount: 0,
    unassignedSources: [],
    groupSnapshot: null,
  };
}

export function feedbackTaskReducer(state: FeedbackTaskState, action: FeedbackTaskAction): FeedbackTaskState {
  if (action.type === "draft") return { ...state, draft: { ...state.draft, ...action.patch } };
  if (action.type === "entries") return { ...state, draft: { ...state.draft, entries: action.entries } };
  if (action.type === "entry") return { ...state, draft: { ...state.draft, entries: state.draft.entries.map((entry) => entry.sessionCode === action.sessionCode ? { ...entry, ...action.patch } : entry) } };
  if (action.type === "class-override") {
    const classOverrides = state.draft.classOverrides.filter((override) => override.sessionCode !== action.sessionCode);
    return {
      ...state,
      draft: {
        ...state.draft,
        classOverrides: action.override ? [...classOverrides, { sessionCode: action.sessionCode, ...action.override }] : classOverrides,
      },
    };
  }
  if (action.type === "student-override") {
    const studentOverrides = state.draft.studentOverrides.filter((override) => override.studentId !== action.studentId);
    return {
      ...state,
      draft: {
        ...state.draft,
        studentOverrides: action.generationConfig ? [...studentOverrides, { studentId: action.studentId, generationConfig: action.generationConfig }] : studentOverrides,
      },
    };
  }
  if (action.type === "stage") return {
    ...state,
    stage: action.stage,
    draft: action.stage === "studio" ? state.draft : { ...state.draft, setupStage: action.stage },
  };
  if (action.type === "task") return { ...state, stage: "studio", planId: action.planId ?? state.planId, batchId: action.batchId ?? state.batchId };
  if (action.type === "restore") return { ...state, stage: action.draft.setupStage, draft: action.draft };
  return state;
}

export function activeTaskEntry(state: FeedbackTaskState) {
  return state.draft.entries.find((entry) => entry.sessionCode === state.draft.activeSessionCode) ?? state.draft.entries[0] ?? null;
}
