import type { CardScore } from "@/lib/types";
import type { TeachingContext } from "@/features/teaching-context";

export interface QuickScoreStudent {
  id: string;
  name: string;
  class: string;
  gender: string;
}

export interface QuickScoreSemester {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  sessionCount: number;
}

export interface QuickScoreHistoryState {
  semesterId: string;
  className: string;
  sessionCode: string;
  date: string;
  cards: CardScore[];
}

export interface QuickScoreSessionState {
  context: TeachingContext;
  date: string;
  cards: CardScore[];
}

export interface QuickScoreSaveResult {
  count: number;
  attUpdated: number;
}
