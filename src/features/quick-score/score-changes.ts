import type { CardScore } from "@/lib/types";
import type { QuickScoreSavePayload } from "./api";

export type OriginalScore = Pick<CardScore, "scoreA" | "scoreB" | "scoreC" | "present">;
export type ScoreField = keyof OriginalScore | "note";
export const SCORE_FIELDS = ["scoreA", "scoreB", "scoreC", "present", "note"] as const;
const emptyScore: OriginalScore = { scoreA: 3, scoreB: 3, scoreC: 3, present: true };

export function quickScoreChanges(card: CardScore, original: OriginalScore = emptyScore) {
  return {
    ...(card.scoreA !== original.scoreA ? { scoreA: card.scoreA } : {}),
    ...(card.scoreB !== original.scoreB ? { scoreB: card.scoreB } : {}),
    ...(card.scoreC !== original.scoreC ? { scoreC: card.scoreC } : {}),
    ...(card.present !== original.present ? { present: card.present } : {}),
    ...(card.note.trim() ? { note: card.note.trim() } : {}),
  };
}

export function quickScorePayload(cards: CardScore[], originals: Map<string, OriginalScore>, date: string, sessionCode: string): QuickScoreSavePayload {
  const scores: QuickScoreSavePayload["scores"] = [];
  const attendances: QuickScoreSavePayload["attendances"] = [];
  for (const card of cards) {
    const { present, ...changes } = quickScoreChanges(card, originals.get(card.studentId));
    if (Object.keys(changes).length) scores.push({ studentId: card.studentId, date, ...changes });
    if (present !== undefined) attendances.push({ studentId: card.studentId, present });
  }
  return { scores, attendances, sessionCode: sessionCode || undefined };
}

export function rebaseQuickScoreCards(latest: CardScore[], saved: CardScore[], originals: Record<string, OriginalScore>) {
  const drafts = new Map(saved.map((card) => [card.studentId, card]));
  return latest.map((card) => {
    const draft = drafts.get(card.studentId);
    return draft ? { ...card, ...quickScoreChanges(draft, originals[card.studentId]) } : card;
  });
}
