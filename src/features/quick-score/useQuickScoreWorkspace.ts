"use client";

import { useMemo, useState } from "react";
import type { CardScore } from "@/lib/types";

export interface OriginalScore { scoreA: number; scoreB: number; scoreC: number; present: boolean; }
function changed(card: CardScore, original?: OriginalScore) { return original ? card.scoreA !== original.scoreA || card.scoreB !== original.scoreB || card.scoreC !== original.scoreC || card.present !== original.present || Boolean(card.note) : card.scoreA !== 3 || card.scoreB !== 3 || card.scoreC !== 3 || !card.present || Boolean(card.note); }

export function useQuickScoreWorkspace() {
  const [cards, setCards] = useState<CardScore[]>([]);
  const [originalScores, setOriginalScores] = useState<Map<string, OriginalScore>>(new Map());
  const changedCards = useMemo(() => cards.filter((card) => changed(card, originalScores.get(card.studentId))), [cards, originalScores]);
  function setScore(index: number, dimension: "A" | "B" | "C", value: number) { setCards((current) => { const next = [...current]; next[index] = { ...next[index], [`score${dimension}`]: value }; return next; }); }
  function togglePresent(index: number) { setCards((current) => { const next = [...current]; next[index] = { ...next[index], present: !next[index].present }; return next; }); }
  function setNote(index: number, note: string) { setCards((current) => { const next = [...current]; next[index] = { ...next[index], note }; return next; }); }
  function bulkSet(dimension: "A" | "B" | "C", value: number) { setCards((current) => current.map((card) => ({ ...card, [`score${dimension}`]: value }))); }
  return { cards, setCards, setOriginalScores, changedCards, changedCount: changedCards.length, absentCount: cards.filter((card) => !card.present).length, setScore, togglePresent, setNote, bulkSet };
}
