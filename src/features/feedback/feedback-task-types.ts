import type { FeedbackIntakeDecision, FeedbackIntakeIssue } from "@/services/feedback-intake-service";

export type FeedbackIntakeRunClient = {
  id: string;
  sessionCode: string;
  status: string;
  sourceManifest: Array<{ name?: string; kind?: string; source?: string }>;
  appliedSummary: {
    appliedStudentCount?: number;
    assessmentStudentCount?: number;
    parsedResult?: { students?: Array<{ studentId?: string; name?: string }> };
    assessmentEvidence?: Record<string, unknown>;
    decisions?: FeedbackIntakeDecision[];
    scopeConfirmation?: { classId: string; sessionCode: string; studentIds: string[]; confirmedAt: string };
  };
  issues: FeedbackIntakeIssue[];
  planId: string | null;
};

export type FeedbackBatchClient = {
  id: string;
  status: string;
  currentPlanId: string | null;
  failedPlanId?: string | null;
  plans: Array<{
    id: string;
    status: string;
    class: { id: string; code: string; name: string | null };
    session?: { code: string } | null;
    progress: { total: number; generated: number; approved: number; exported: number; failed: number };
  }>;
};
