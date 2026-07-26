import type { TeachingSummaryBundle } from "@/lib/contracts/teaching-summary";

export interface LegacyDailyHistoryState {
  kind: "daily";
  semesterId: string;
  className: string;
  sessionCode: string;
  report: string;
}

export interface TeachingSummaryHistoryState {
  kind: "teaching-summary";
  view: "session" | "date";
  semesterId: string;
  className: string;
  sessionCode: string;
  date: string;
  includeCommunications: boolean;
  bundle: TeachingSummaryBundle;
}

export type DailyHistoryState = LegacyDailyHistoryState | TeachingSummaryHistoryState;

export function isDailyHistoryState(value: unknown): value is DailyHistoryState {
  if (!value || typeof value !== "object") return false;
  return ["daily", "teaching-summary"].includes(String((value as { kind?: unknown }).kind));
}
