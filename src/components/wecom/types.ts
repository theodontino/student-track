import type { AttentionSignalCandidate } from "@/lib/attention-labels";

export interface WeComImportPlanItem {
  student: { id: string; name: string; studentId: string };
  session: { id: string; code: string; date: string; semesterNumber: number };
  source: { conversationId: string; conversationTitle: string };
  occurredAt: string;
  target: string;
  summary: string;
  sourceKey: string;
  duplicate: boolean;
  binding: "explicit_session" | "first_class_session_fallback";
  attentionSignals: AttentionSignalCandidate[];
}

export interface WeComImportSkippedItem {
  title: string;
  name: string;
  reason: string;
}

export interface WeComImportResult {
  sourceLabel: string;
  mode: "dry-run" | "apply";
  communicationCandidateCount: number;
  aiContextCandidateCount: number;
  attentionCandidateCount: number;
  importableCount: number;
  createCount: number;
  duplicateCount: number;
  skippedCount: number;
  createdCount: number;
  createdLabelCount: number;
  backupPath?: string;
  plans: WeComImportPlanItem[];
  skipped: WeComImportSkippedItem[];
}

export interface WeComCandidatePath {
  path: string;
  modifiedAt: string;
}

export interface WeComCatchResult {
  command: string;
  scriptPath: string;
  stdout: string;
  stderr: string;
  parsed: unknown | null;
  warning?: string;
}

export interface FeedbackContextPreview {
  today: string[];
  trend: string;
  communications: string[];
  labels: string[];
}

export interface FeedbackContextStudent {
  id: string;
  name: string;
  studentId: string;
  labels: string[];
  preview: FeedbackContextPreview;
}
