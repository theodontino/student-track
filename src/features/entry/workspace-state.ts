import type { DraftParseResult, DraftRecordView, DraftStructuredResult } from "@/lib/types";
import type { TeachingContext } from "@/features/teaching-context";

export interface InputWorkspaceState {
  context: TeachingContext;
  rawText: string;
  result: DraftParseResult | null;
}

export function isInputWorkspaceState(value: unknown): value is InputWorkspaceState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<InputWorkspaceState>;
  return Boolean(state.context)
    && typeof state.context?.semesterId === "string"
    && typeof state.context?.className === "string"
    && typeof state.context?.sessionCode === "string"
    && typeof state.rawText === "string"
    && (state.result === null || typeof state.result === "object");
}

export type ReviewFilterStatus = "pending" | "confirmed" | "rejected";

export interface ReviewWorkspaceState {
  edits: Record<string, DraftStructuredResult>;
  expandedId: string | null;
  filterStatus: ReviewFilterStatus;
  filterClass: string;
}

export function isReviewWorkspaceState(value: unknown): value is ReviewWorkspaceState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ReviewWorkspaceState>;
  return Boolean(state.edits) && typeof state.edits === "object"
    && (state.expandedId === null || typeof state.expandedId === "string")
    && ["pending", "confirmed", "rejected"].includes(state.filterStatus ?? "")
    && typeof state.filterClass === "string";
}

export function reviewedStudentCount(draft: Pick<DraftRecordView, "reviewResult">) {
  if (!draft.reviewResult) return 0;
  return new Set([
    ...Object.keys(draft.reviewResult.revised_scores || {}),
    ...Object.keys(draft.reviewResult.revised_events || {}),
  ]).size;
}
