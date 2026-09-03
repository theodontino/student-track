import type {
  FeedbackClosureType,
  FeedbackGenerationPreferences,
  FeedbackPlanItemGenerationConfig,
  FeedbackPlanType,
} from "@/lib/feedback-plan";
import type { FeedbackGroupIntakeUnassigned } from "./feedback-task-types";

export type TaskStage = "prepare" | "confirm" | "studio";
export type FeedbackTaskView = "intake" | "plan" | "studio";
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
  rangeStartSessionId?: string;
  rangeEndSessionId?: string;
  runId: string;
  studentIds: string[];
  /** false 表示仍由推荐规则维护；教师明确调整后设为 true，后续材料不再覆盖。 */
  studentSelectionInitialized: boolean;
  selected: boolean;
};

export type FeedbackTaskRevisionSource =
  | { kind: "plan"; planId: string; type: FeedbackPlanType }
  | { kind: "batch"; batchId: string; type: "event_micro" | "stage_trend" };

export type FeedbackTaskCurrentFactsSeed = {
  revisionSource: FeedbackTaskRevisionSource;
  displayName: string;
  mode: "single" | "group";
  groupLessonId: string;
  activeSessionCode: string;
  entries: FeedbackTaskClassDraft[];
  materialSelection: MaterialSelection;
  materialSelectionInitialized: boolean;
  generationMode: "standard" | "fast";
  outputRequirement: string;
  preferences: FeedbackTaskPreferences;
  classOverrides: FeedbackTaskClassOverrideDraft[];
  studentOverrides: FeedbackTaskStudentOverrideDraft[];
};

export type FeedbackTaskGroupSnapshot = {
  groupLessonId: string;
  activeSessionCode: string;
  entries: FeedbackTaskClassDraft[];
  /** 本轮已成功建立反馈计划的课次；用于后续班级保留账本但禁止重复纳入。 */
  plannedSessionCodes: string[];
  unassignedSourceCount: number;
  unassignedSources: FeedbackGroupIntakeUnassigned[];
};

export type FeedbackTaskDraftV2 = {
  version: 2;
  /** 教师可见的计划名称；服务端建立草稿时会处理同范围重名。 */
  displayName: string;
  setupStage: "prepare" | "confirm";
  requestKey: string;
  /** 为空表示全新计划；存在时表示录入新事实后从该计划建立一条新修订。 */
  revisionSource: FeedbackTaskRevisionSource | null;
  mode: "single" | "group";
  groupLessonId: string;
  activeSessionCode: string;
  entries: FeedbackTaskClassDraft[];
  /** 本轮已成功建立反馈计划的课次；用于后续班级保留账本但禁止重复纳入。 */
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
  | { type: "task"; planId?: string; batchId?: string; stage?: TaskStage }
  | { type: "restore"; draft: FeedbackTaskDraftV2 };

export function createFeedbackTaskDraft(): FeedbackTaskDraftV2 {
  return {
    version: 2,
    displayName: "初版计划",
    setupStage: "prepare",
    requestKey: crypto.randomUUID(),
    revisionSource: null,
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

export function feedbackTaskViewForStage(stage: TaskStage): FeedbackTaskView {
  if (stage === "prepare") return "intake";
  if (stage === "confirm") return "plan";
  return "studio";
}

export function feedbackTaskStageForView(view: string | null | undefined, hasPlan: boolean): TaskStage {
  if (view === "intake") return "prepare";
  if (view === "plan") return "confirm";
  if (view === "studio") return hasPlan ? "studio" : "prepare";
  return hasPlan ? "studio" : "prepare";
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
  if (action.type === "task") return { ...state, stage: action.stage ?? "studio", planId: action.planId ?? state.planId, batchId: action.batchId ?? state.batchId };
  if (action.type === "restore") return { ...state, stage: action.draft.setupStage, draft: action.draft };
  return state;
}

export function activeTaskEntry(state: FeedbackTaskState) {
  return state.draft.entries.find((entry) => entry.sessionCode === state.draft.activeSessionCode) ?? state.draft.entries[0] ?? null;
}
