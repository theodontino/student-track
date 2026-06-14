// v0.13.1: 共享类型 — 各页面提取，避免重复定义

export interface Semester {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  sessionCount: number;
}

export interface StudentItem {
  id: string;
  name: string;
  class: string;
  classCode: string;
  studentId: string;
  gender: string;
  labels: { id: string; name: string }[];
  scores?: { scoreA: number; scoreB: number; scoreC: number; scoreD: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionInfo {
  id: string;
  code: string;
  semesterNumber: number;
  date: string;
  class: string | null;
  attendanceCount: number;
}

export interface CardScore {
  studentId: string;
  studentName: string;
  scoreA: number;
  scoreB: number;
  scoreC: number;
  present: boolean;
  note: string;
}

export interface DraftParseResult {
  draftId: string;
  rawText: string;
  parsedResult: {
    students: {
      name: string;
      scores: { A: number | null; B: number | null; C: number | null };
      events: string[];
      communication: { type: string; summary: string } | null;
      present: boolean;
    }[];
    alert_suggestion: string;
  };
  reviewResult: {
    is_valid: boolean;
    issues: string[];
    suggestions: string[];
    revised_scores: Record<string, any>;
    revised_events: Record<string, string[]>;
  } | null;
  status: string;
  createdAt: string;
  corrections?: { original: string; corrected: string; confidence: string; reason: string }[];
}
