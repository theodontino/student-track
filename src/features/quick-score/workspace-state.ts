import type { CardScore } from "@/lib/types";
import { isTeachingContext } from "@/features/teaching-context/url-context";
import type { QuickScoreSessionState } from "./types";

export function isCardScore(value: unknown): value is CardScore {
  if (!value || typeof value !== "object") return false;
  const card = value as Partial<CardScore>;
  return typeof card.studentId === "string"
    && typeof card.studentName === "string"
    && typeof card.scoreA === "number"
    && typeof card.scoreB === "number"
    && typeof card.scoreC === "number"
    && typeof card.present === "boolean"
    && typeof card.note === "string";
}

export function isQuickScoreSessionState(value: unknown): value is QuickScoreSessionState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<QuickScoreSessionState>;
  return isTeachingContext(state.context)
    && typeof state.date === "string"
    && Array.isArray(state.cards)
    && state.cards.every(isCardScore);
}
