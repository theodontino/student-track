"use client";

import { useReducer } from "react";
import {
  aiWorkflowReducer,
  INITIAL_AI_WORKFLOW_STATE,
  type AiWorkflowActivePhase,
  type AiWorkflowState,
} from "./workflow-machine";

export function useAiWorkflow(initialState: AiWorkflowState = INITIAL_AI_WORKFLOW_STATE) {
  const [state, dispatch] = useReducer(aiWorkflowReducer, initialState);
  return {
    state,
    start(operation: string, message?: string) { dispatch({ type: "start", operation, message }); },
    transition(phase: AiWorkflowActivePhase | "completed", message?: string) { dispatch({ type: "transition", phase, message }); },
    progress(progress: number, message?: string) { dispatch({ type: "progress", progress, message }); },
    fail(error: string, retryPhase?: AiWorkflowActivePhase, message?: string) { dispatch({ type: "fail", error, retryPhase, message }); },
    cancel(message?: string) { dispatch({ type: "cancel", message }); },
    reset() { dispatch({ type: "reset" }); },
    restore(saved: unknown) { dispatch({ type: "restore", state: saved }); },
  };
}
