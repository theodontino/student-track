import type { SessionInfo } from "@/lib/types";
import { requestJson } from "@/lib/api-client";
import type {
  QuickScoreSaveResult,
  QuickScoreSemester,
  QuickScoreStudent,
} from "./types";

export interface QuickScoreItem {
  studentId: string;
  scoreA: number;
  scoreB: number;
  scoreC: number;
  present: boolean;
}

export interface QuickScoreSavePayload {
  scores: Array<{
    studentId: string;
    date: string;
    scoreA: number;
    scoreB: number;
    scoreC: number;
    note?: string;
  }>;
  sessionCode?: string;
  attendances: Array<{ studentId: string; present: boolean }>;
}

export async function loadQuickScoreReferenceData() {
  const [students, semesters] = await Promise.all([
    requestJson<QuickScoreStudent[]>("/api/students"),
    requestJson<QuickScoreSemester[]>("/api/semesters"),
  ]);
  return { students, semesters };
}

export function loadQuickScoreSession(className: string, sessionCode: string) {
  const params = new URLSearchParams({ class: className, sessionCode });
  return requestJson<{ scores: QuickScoreItem[] }>(`/api/quick-score?${params.toString()}`);
}

export function loadQuickScoreSessions(semesterId: string, className: string) {
  const params = new URLSearchParams({ semesterId, className });
  return requestJson<SessionInfo[]>(`/api/sessions?${params.toString()}`);
}

export function createQuickScoreSession(semesterId: string, className: string) {
  return requestJson<SessionInfo>(`/api/semesters/${encodeURIComponent(semesterId)}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ className }),
  });
}

export function deleteQuickScoreSession(semesterId: string, sessionCode: string) {
  const params = new URLSearchParams({ code: sessionCode });
  return requestJson<{ deleted: boolean }>(
    `/api/semesters/${encodeURIComponent(semesterId)}/session?${params.toString()}`,
    { method: "DELETE" },
  );
}

export function saveQuickScores(payload: QuickScoreSavePayload) {
  return requestJson<QuickScoreSaveResult>("/api/quick-score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
