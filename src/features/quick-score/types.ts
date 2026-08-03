import type { CardScore } from "@/lib/types";
import type { TeachingContext } from "@/features/teaching-context/types";

export interface QuickScoreStudent {
  id: string;
  name: string;
  class: string;
  classId?: string;
  gender: string;
}

export interface QuickScoreClass {
  id: string;
  code: string;
  name: string | null;
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
  classId?: string;
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

export type QuickScoreNotice = { tone: "info" | "success" | "danger"; message: string };
