import type { StudentSemesterSummary } from "@/services/student-semester-summary-service";

export interface StudentListItem {
  id: string;
  name: string;
  class: string;
  classCode: string;
  studentId: string;
  gender: string;
  labels: { id: string; name: string }[];
  scores?: { scoreA: number; scoreB: number; scoreC: number; scoreD: number } | null;
  semesterSummary?: StudentSemesterSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudentFormState {
  name: string;
  classCode: string;
  studentId: string;
  gender: string;
  labelNames: string[];
}

export interface StudentImportResult {
  success?: boolean;
  total?: number;
  successCount?: number;
  errorCount?: number;
  errors?: string[];
  error?: string;
}

export interface StudentEvent {
  id: string;
  session: { date: string; code: string; semesterNumber: number };
  type: string;
  description: string;
  rawText: string;
}

export interface StudentCommunication {
  id: string;
  session: { date: string; code: string };
  target: string;
  summary: string;
}

export interface StudentAttendance {
  id: string;
  present: boolean;
  session: { date: string; semesterNumber: number; code: string };
}

export interface StudentDetail {
  id: string;
  name: string;
  class: string;
  studentId: string;
  gender: string;
  labels: { id: string; name: string }[];
  sessionMetrics: { id: string; date: string; scoreA: number; scoreB: number; scoreC: number; scoreD: number }[];
  events: StudentEvent[];
  communications: StudentCommunication[];
  attendances: StudentAttendance[];
  semesterSummary: StudentSemesterSummary | null;
  _pagination?: { eventHasMore: boolean; commHasMore: boolean };
}

export type StudentDetailPanel = "events" | "communications" | "attendance";

export function studentDetailPanelTitle(panel: StudentDetailPanel) {
  if (panel === "events") return "关键事件";
  if (panel === "communications") return "家校沟通";
  return "考勤记录";
}

export function studentEventTone(type: string) {
  if (type === "测验成绩") return "success" as const;
  if (type === "心理状态") return "warning" as const;
  if (type === "家校沟通") return "warning" as const;
  return "info" as const;
}
