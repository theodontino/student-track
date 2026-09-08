"use client";

import { useMemo, useState } from "react";
import type { CardScore } from "@/lib/types";
import { quickScoreChanges, type OriginalScore } from "./score-changes";

export type { OriginalScore } from "./score-changes";
export function hasQuickScoreCardChanged(card: CardScore, original?: OriginalScore) { return Object.keys(quickScoreChanges(card, original)).length > 0; }

export function useQuickScoreWorkspace() {
  const [cards, setCards] = useState<CardScore[]>([]);
  const [originalScores, setOriginalScores] = useState<Map<string, OriginalScore>>(new Map());
  const changedCards = useMemo(() => cards.filter((card) => hasQuickScoreCardChanged(card, originalScores.get(card.studentId))), [cards, originalScores]);
  function setScore(index: number, dimension: "A" | "B" | "C", value: number) { setCards((current) => { const next = [...current]; next[index] = { ...next[index], [`score${dimension}`]: value }; return next; }); }
  function togglePresent(index: number) { setCards((current) => { const next = [...current]; next[index] = { ...next[index], present: !next[index].present }; return next; }); }
  function setNote(index: number, note: string) { setCards((current) => { const next = [...current]; next[index] = { ...next[index], note }; return next; }); }
  function bulkSet(dimension: "A" | "B" | "C", value: number) { setCards((current) => current.map((card) => ({ ...card, [`score${dimension}`]: value }))); }
  return { cards, originalScores, setCards, setOriginalScores, changedCards, changedCount: changedCards.length, absentCount: cards.filter((card) => !card.present).length, setScore, togglePresent, setNote, bulkSet };
}
