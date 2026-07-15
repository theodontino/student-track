import { isTeachingContext } from "@/features/teaching-context/url-context";
import { isAiWorkflowState } from "@/features/ai-workflow";
import type { FeedbackWorkspaceState } from "./types";

export function isFeedbackWorkspace(value: unknown): value is FeedbackWorkspaceState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<FeedbackWorkspaceState>;
  return isTeachingContext(state.context)
    && typeof state.newSessionDate === "string"
    && typeof state.rawText === "string"
    && typeof state.parseStatus === "string"
    && typeof state.streamContent === "string"
    && typeof state.draftId === "string"
    && (state.parsedResult === null || typeof state.parsedResult === "object")
    && (state.reviewResult === null || typeof state.reviewResult === "object")
    && Array.isArray(state.corrections)
    && typeof state.confirmed === "boolean"
    && typeof state.status === "string"
    && Array.isArray(state.feedbackCards)
    && typeof state.feedbackTotal === "number"
    && typeof state.feedbackDone === "number"
    && typeof state.feedbackDirty === "boolean"
    && typeof state.forceRegenerate === "boolean"
    && typeof state.singleStudentId === "string"
    && typeof state.singleDays === "number"
    && typeof state.singleFeedback === "string"
    && (state.workflow === undefined || isAiWorkflowState(state.workflow));
}

export function todayLocalDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
