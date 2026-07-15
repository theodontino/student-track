export type AiWorkflowPhase =
  | "idle"
  | "validating"
  | "generating"
  | "reviewing"
  | "saving"
  | "completed"
  | "failed"
  | "cancelled";

export type AiWorkflowActivePhase = Exclude<AiWorkflowPhase, "idle" | "completed" | "failed" | "cancelled">;

interface WorkflowBase {
  operation: string;
  message: string;
  updatedAt: string;
}

export type AiWorkflowState =
  | { phase: "idle"; operation: ""; message: ""; updatedAt: "" }
  | (WorkflowBase & { phase: AiWorkflowActivePhase; startedAt: string; progress: number | null })
  | (WorkflowBase & { phase: "completed"; startedAt: string; completedAt: string })
  | (WorkflowBase & { phase: "failed"; startedAt: string; error: string; retryPhase: AiWorkflowActivePhase })
  | (WorkflowBase & { phase: "cancelled"; startedAt: string; cancelledAt: string });

export type AiWorkflowAction =
  | { type: "start"; operation: string; message?: string; now?: string }
  | { type: "transition"; phase: AiWorkflowActivePhase | "completed"; message?: string; now?: string }
  | { type: "progress"; progress: number; message?: string; now?: string }
  | { type: "fail"; error: string; message?: string; retryPhase?: AiWorkflowActivePhase; now?: string }
  | { type: "cancel"; message?: string; now?: string }
  | { type: "reset" }
  | { type: "restore"; state: unknown; now?: string };

export const INITIAL_AI_WORKFLOW_STATE: AiWorkflowState = {
  phase: "idle",
  operation: "",
  message: "",
  updatedAt: "",
};

const ACTIVE_PHASES: AiWorkflowActivePhase[] = ["validating", "generating", "reviewing", "saving"];

const ALLOWED_TRANSITIONS: Record<AiWorkflowActivePhase, ReadonlyArray<AiWorkflowActivePhase | "completed">> = {
  validating: ["generating", "reviewing", "saving", "completed"],
  generating: ["reviewing", "saving", "completed"],
  reviewing: ["saving", "completed"],
  saving: ["completed"],
};

function timestamp(now?: string) {
  return now ?? new Date().toISOString();
}

function isActivePhase(value: unknown): value is AiWorkflowActivePhase {
  return typeof value === "string" && ACTIVE_PHASES.includes(value as AiWorkflowActivePhase);
}

function startedAt(state: Exclude<AiWorkflowState, { phase: "idle" }>, now: string) {
  return state.startedAt || now;
}

export function isAiWorkflowState(value: unknown): value is AiWorkflowState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<AiWorkflowState>;
  if (state.phase === "idle") {
    return state.operation === "" && state.message === "" && state.updatedAt === "";
  }
  if (typeof state.operation !== "string" || typeof state.message !== "string" || typeof state.updatedAt !== "string") return false;
  if (!("startedAt" in state) || typeof state.startedAt !== "string") return false;
  if (isActivePhase(state.phase)) {
    return "progress" in state && (state.progress === null || typeof state.progress === "number");
  }
  if (state.phase === "completed") return "completedAt" in state && typeof state.completedAt === "string";
  if (state.phase === "failed") {
    return "error" in state && typeof state.error === "string"
      && "retryPhase" in state && isActivePhase(state.retryPhase);
  }
  return state.phase === "cancelled" && "cancelledAt" in state && typeof state.cancelledAt === "string";
}

/**
 * Active browser tasks cannot survive a refresh. Persisted active states are
 * therefore recovered as retryable failures instead of pretending work is
 * still running.
 */
export function recoverAiWorkflowState(value: unknown, now?: string): AiWorkflowState {
  if (!isAiWorkflowState(value)) return INITIAL_AI_WORKFLOW_STATE;
  if (value.phase === "idle" || value.phase === "completed" || value.phase === "failed" || value.phase === "cancelled") return value;
  const updatedAt = timestamp(now);
  return {
    phase: "failed",
    operation: value.operation,
    message: "上次任务在页面离开时中断，可安全重试。",
    updatedAt,
    startedAt: value.startedAt,
    error: "任务未在当前页面完成",
    retryPhase: value.phase,
  };
}

export function aiWorkflowReducer(state: AiWorkflowState, action: AiWorkflowAction): AiWorkflowState {
  if (action.type === "reset") return INITIAL_AI_WORKFLOW_STATE;
  if (action.type === "restore") return recoverAiWorkflowState(action.state, action.now);

  const now = timestamp(action.now);
  if (action.type === "start") {
    return {
      phase: "validating",
      operation: action.operation,
      message: action.message ?? "正在检查任务条件…",
      updatedAt: now,
      startedAt: now,
      progress: null,
    };
  }
  if (state.phase === "idle") return state;

  if (action.type === "transition") {
    const currentPhase = state.phase === "failed" ? state.retryPhase : state.phase;
    if (!isActivePhase(currentPhase) || !ALLOWED_TRANSITIONS[currentPhase].includes(action.phase)) return state;
    if (action.phase === "completed") {
      return {
        phase: "completed",
        operation: state.operation,
        message: action.message ?? "任务已完成。",
        updatedAt: now,
        startedAt: startedAt(state, now),
        completedAt: now,
      };
    }
    return {
      phase: action.phase,
      operation: state.operation,
      message: action.message ?? state.message,
      updatedAt: now,
      startedAt: startedAt(state, now),
      progress: null,
    };
  }

  if (action.type === "progress") {
    if (state.phase !== "generating") return state;
    return {
      ...state,
      progress: Math.max(0, Math.min(1, action.progress)),
      message: action.message ?? state.message,
      updatedAt: now,
    };
  }

  if (action.type === "fail") {
    const retryPhase = action.retryPhase ?? (isActivePhase(state.phase) ? state.phase : state.phase === "failed" ? state.retryPhase : "validating");
    return {
      phase: "failed",
      operation: state.operation,
      message: action.message ?? "任务未完成，请检查后重试。",
      updatedAt: now,
      startedAt: startedAt(state, now),
      error: action.error,
      retryPhase,
    };
  }

  return {
    phase: "cancelled",
    operation: state.operation,
    message: action.message ?? "任务已取消。",
    updatedAt: now,
    startedAt: startedAt(state, now),
    cancelledAt: now,
  };
}

export function isAiWorkflowBusy(state: AiWorkflowState) {
  return isActivePhase(state.phase) && state.phase !== "reviewing";
}
