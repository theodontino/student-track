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
    sourceFacts?: Array<{
      key: string;
      kind: string;
      parsedResult?: { students?: Array<{ studentId?: string; name?: string; present?: boolean }> };
      issues?: FeedbackIntakeIssue[];
      unresolvedStudents?: Array<{ issueId: string }>;
      assistantMatch?: {
        matchedClass: boolean;
        matchedStudents: number;
        totalStudentRows: number;
        sessionStatus: "matched" | "missing" | "mismatch";
      };
    }>;
    scopeConfirmation?: { classId: string; sessionCode: string; studentIds: string[]; confirmedAt: string };
  };
  issues: FeedbackIntakeIssue[];
  planId: string | null;
};

export type FeedbackGroupIntakeClassClient = {
  classId: string;
  classCode: string;
  className: string;
  sessionCode: string;
  studentIds: string[];
  studentCount: number;
  runId: string;
  status: string;
  issueCount: number;
};

export type FeedbackGroupIntakeSourceStatus = "empty" | "complete" | "partial" | "unassigned" | "needs_review";

export type FeedbackGroupIntakeSourceSummary =
  | {
      kind: "assistant_roster" | "step_classroom";
      fileCount: number;
      matchedClasses: number;
      totalClasses: number;
      issueCount: number;
      status: FeedbackGroupIntakeSourceStatus;
    }
  | {
      kind: "assessment_pdf";
      fileCount: number;
      matchedStudents: number;
      totalStudents: number;
      issueCount: number;
      status: FeedbackGroupIntakeSourceStatus;
    };

export type FeedbackGroupIntakeUnassigned = {
  fileName: string;
  kind: "assistant_roster" | "step_classroom" | "assessment_pdf" | "ignored";
  reason: string;
  blocking?: boolean;
  reportedStudentId?: string;
  reportedStudentName?: string;
  candidateStudentIds?: string[];
  candidateClassIds?: string[];
};

export type FeedbackGroupIntakeUploadResponse = {
  runs: FeedbackIntakeRunClient[];
  classes: FeedbackGroupIntakeClassClient[];
  sourceSummaries: FeedbackGroupIntakeSourceSummary[];
  unassigned: FeedbackGroupIntakeUnassigned[];
};

export type FeedbackBatchClient = {
  id: string;
  status: string;
  generationApproach?: "restricted" | "free" | null;
  generationApproachLabel?: string;
  currentPlanId: string | null;
  failedPlanId?: string | null;
  plans: Array<{
    id: string;
    status: string;
    generationApproach?: "restricted" | "free" | null;
    generationApproachLabel?: string;
    class: { id: string; code: string; name: string | null };
    session?: { code: string } | null;
    rangeEndSession?: { code: string } | null;
    progress: { total: number; generated: number; approved: number; exported: number; failed: number };
    items: Array<{
      id: string;
      status: string;
      studentId: string | null;
      student: { id: string; name: string; studentId: string } | null;
      generationExecution?: {
        requestedApproach: "restricted" | "free";
        nextApproach: "restricted" | "free";
        attempts: Array<{
          actualApproach: "restricted" | "free";
          status: string;
          stage?: "planner" | "writer" | "free" | "deterministic_check";
          error?: {
            code: string;
            message: string;
            retryable: boolean;
            kind?: "schema" | "timeout" | "connection" | "aborted" | "service";
          };
        }>;
      } | null;
    }>;
  }>;
};

export type FeedbackStudioPlanTarget = {
  id: string;
  classId: string;
  className: string;
  sessionCode: string;
};
