// v0.13.1: 共享类型 — 各页面提取，避免重复定义

import type { AttentionSignalCandidate } from "@/lib/attention-labels";

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

export interface TeacherIntervention {
  observedProblem: string;
  teacherAction: string;
  outcome?: string;
  evidenceText: string;
}

export type ScoreDimension = "A" | "B" | "C";

export interface DraftStudent {
  name: string;
  /** Optional for legacy/NL drafts; required and validated for STEP imports. */
  studentId?: string;
  scores: Record<ScoreDimension, number | null>;
  events: string[];
  communication: { type: string; summary: string; occurredAt?: string } | null;
  present?: boolean;
  attentionSignals?: AttentionSignalCandidate[];
  teacherInterventions?: TeacherIntervention[];
}

export interface DraftStructuredResult {
  students: DraftStudent[];
  alert_suggestion: string;
}

export interface DraftReviewResult {
  is_valid: boolean;
  issues: string[];
  suggestions: string[];
  revised_scores: Record<string, Record<string, number | null>>;
  revised_events: Record<string, string[]>;
  revised_teacher_interventions?: Record<string, TeacherIntervention[]>;
}

export interface NameCorrection {
  original: string;
  corrected: string;
  confidence: "high" | "medium" | "low";
  reason?: string;
}

export interface DraftParseResult {
  draftId: string;
  rawText: string;
  parsedResult: DraftStructuredResult;
  reviewResult: DraftReviewResult | null;
  status: string;
  createdAt: string;
  corrections?: NameCorrection[];
}

export interface DraftRecordView {
  id: string;
  rawText: string;
  parsedResult: DraftStructuredResult;
  reviewResult: DraftReviewResult | null;
  status: string;
  sessionCode?: string | null;
  createdAt: string;
}
