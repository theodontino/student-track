import { z } from "zod";
import { FEEDBACK_COMMUNICATION_CATEGORIES } from "@/lib/feedback-communication";

export const TeachingSummaryScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionCode: z.string().trim().min(1) }).strict(),
  z.object({
    type: z.literal("date"),
    semesterId: z.string().trim().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict(),
]);

export const TeachingSummaryRequestSchema = z.object({
  scope: TeachingSummaryScopeSchema,
  includeCommunications: z.boolean().default(true),
  forceRefresh: z.boolean().default(false),
}).strict();

export const ObservationStatusSchema = z.enum(["new", "read", "deferred", "handled", "ignored"]);
export const ObservationKindSchema = z.enum([
  "repeated-parent-concern",
  "classroom-alignment",
  "classroom-conflict",
  "pending-teacher-commitment",
  "concern-escalation",
]);

const EvidenceItemSchema = z.object({
  title: z.string().trim().min(1).max(80),
  detail: z.string().trim().min(1).max(360),
  studentRefs: z.array(z.string()).max(20),
  sessionRefs: z.array(z.string()).max(20),
  communicationRefs: z.array(z.string()).max(20),
}).strict().superRefine((value, context) => {
  if (value.studentRefs.length + value.sessionRefs.length + value.communicationRefs.length === 0) {
    context.addIssue({ code: "custom", message: "分析项必须包含至少一个来源引用" });
  }
});

const ObservationCandidateSchema = z.object({
  studentRef: z.string(),
  kind: ObservationKindSchema,
  topic: z.enum(FEEDBACK_COMMUNICATION_CATEGORIES),
  title: z.string().trim().min(1).max(80),
  evidenceSummary: z.string().trim().min(1).max(360),
  communicationRefs: z.array(z.string()).min(1).max(20),
  sessionRefs: z.array(z.string()).max(20),
}).strict();

export const TeachingInterpretationSchema = z.object({
  overview: z.string().trim().max(800).nullable(),
  classComparisons: z.array(EvidenceItemSchema).max(8),
  noteworthyChanges: z.array(EvidenceItemSchema).max(12),
  suggestedActions: z.array(EvidenceItemSchema).max(12),
  observationCandidates: z.array(ObservationCandidateSchema).max(30),
}).strict();

export type TeachingSummaryScope = z.infer<typeof TeachingSummaryScopeSchema>;
export type TeachingSummaryRequest = z.infer<typeof TeachingSummaryRequestSchema>;
export type TeachingInterpretation = z.infer<typeof TeachingInterpretationSchema>;
export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;
export type ObservationKind = z.infer<typeof ObservationKindSchema>;

export interface TeachingSummaryFacts {
  scope: TeachingSummaryScope;
  scopeKey: string;
  semester: { id: string; name: string; startDate: string; endDate: string };
  date: string;
  totals: {
    sessionCount: number;
    classCount: number;
    coveredStudentCount: number;
    metricRecordedCount: number;
    attendanceRecordedCount: number;
    presentCount: number;
    absentCount: number;
    eventCount: number;
    pendingDraftCount: number;
    missingFeedbackHistoryCount: number;
    communicationCount: number;
    communicationInputTruncated: boolean;
  };
  sessions: TeachingSessionFact[];
  students: TeachingStudentFact[];
  pendingItems: Array<{
    type: "missing-metrics" | "missing-attendance" | "pending-drafts" | "feedback-history-missing";
    label: string;
    count: number;
    sessionCode: string;
    href: string;
  }>;
}

export interface TeachingSessionFact {
  id: string;
  code: string;
  date: string;
  semesterNumber: number;
  classId: string | null;
  className: string;
  studentCount: number;
  metricRecordedCount: number;
  attendanceRecordedCount: number;
  presentCount: number;
  absentCount: number;
  eventCount: number;
  communicationCount: number;
  averages: { A: number | null; B: number | null; C: number | null; D: number | null };
  pendingDraftCount: number;
  feedbackHistoryFound: boolean;
  href: string;
}

export interface TeachingStudentFact {
  id: string;
  name: string;
  className: string;
  sessionCodes: string[];
  selectedComposite: number | null;
  previousComposite: number | null;
  change: number | null;
  eventCount: number;
  communicationCount: number;
  href: string;
}

export interface TeachingEvidenceItem {
  title: string;
  detail: string;
  sources: {
    students: Array<{ id: string; name: string; href: string }>;
    sessions: Array<{ id: string; code: string; date: string; href: string }>;
    communications: Array<{
      id: string;
      studentId: string;
      target: string;
      summary: string;
      occurredAt: string;
      category: string;
      priority: string;
      sessionId: string;
      sessionCode: string;
      href: string;
    }>;
  };
}

export interface ResolvedTeachingInterpretation {
  overview: string | null;
  classComparisons: TeachingEvidenceItem[];
  noteworthyChanges: TeachingEvidenceItem[];
  suggestedActions: TeachingEvidenceItem[];
}

export interface TeacherObservationView {
  id: string;
  kind: string;
  topic: string;
  title: string;
  evidenceSummary: string;
  status: ObservationStatus;
  analysisVersion: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  statusChangedAt: string;
  student: {
    id: string;
    name: string;
    studentId: string;
    classId: string;
    className: string;
    href: string;
  };
  sources: Array<{
    communicationId: string;
    target: string;
    summary: string;
    occurredAt: string;
    sessionCode: string;
    sessionDate: string;
    relatedSessionCode: string | null;
    studentHref: string;
    sessionHref: string;
  }>;
}

export interface TeachingSummaryBundle {
  facts: TeachingSummaryFacts;
  analysis: ResolvedTeachingInterpretation | null;
  observations: TeacherObservationView[];
  cache: {
    status: "miss" | "hit" | "stale";
    generatedAt: string | null;
  };
}
