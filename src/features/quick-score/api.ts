import type { SessionInfo } from "@/lib/types";
import { requestJson } from "@/lib/api-client";
import type {
  QuickScoreSaveResult,
  QuickScoreClass,
  QuickScoreSemester,
  QuickScoreStudent,
} from "./types";

export interface QuickScoreItem {
  studentId: string;
  studentName: string;
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

export async function loadQuickScoreReferenceData(semesterId?: string) {
  const studentQuery = new URLSearchParams({ scope: "active" });
  if (semesterId) studentQuery.set("semesterId", semesterId);
  const [students, semesters, classes] = await Promise.all([
    requestJson<QuickScoreStudent[]>(`/api/students?${studentQuery}`),
    requestJson<QuickScoreSemester[]>("/api/semesters"),
    semesterId
      ? requestJson<QuickScoreClass[]>(`/api/semesters/${encodeURIComponent(semesterId)}/classes`)
      : Promise.resolve([]),
  ]);
  return { students, semesters, classes };
}

export function loadQuickScoreSession(className: string, sessionCode: string, semesterId?: string, classId?: string) {
  const params = new URLSearchParams();
  if (classId) {
    if (semesterId) params.set("semesterId", semesterId);
    params.set("classId", classId);
  } else {
    params.set("class", className);
    if (semesterId) params.set("semesterId", semesterId);
  }
  params.set("sessionCode", sessionCode);
  return requestJson<{ scores: QuickScoreItem[] }>(`/api/quick-score?${params.toString()}`);
}

export function loadQuickScoreSessions(semesterId: string, className: string, classId?: string) {
  const params = new URLSearchParams({ semesterId });
  if (classId) params.set("classId", classId);
  else params.set("className", className);
  return requestJson<SessionInfo[]>(`/api/sessions?${params.toString()}`);
}

export function createQuickScoreSession(semesterId: string, className: string, classId?: string) {
  return requestJson<SessionInfo>(`/api/semesters/${encodeURIComponent(semesterId)}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ className, ...(classId ? { classId } : {}) }),
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
