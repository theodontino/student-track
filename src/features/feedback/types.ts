import type { FeedbackContextStudent } from "@/features/feedback/context-types";
import type { FeedbackIntensity, FeedbackRoutingReason } from "@/lib/feedback-intensity";
import type { LessonFeedbackMaterial } from "@/lib/feedback-materials";

export interface FeedbackContextResponse {
  session?: {
    id: string;
    code: string;
    date: string;
    semesterId: string;
    semesterNumber: number;
    classId: string;
  };
  className: string;
  groupProgress?: {
    group: {
      id: string;
      name: string;
      members?: Array<{
        classId: string;
        classCode: string;
        className: string | null;
        session: { id: string; code: string; date: string; classId: string | null } | null;
      }>;
    };
    leadClass: { id: string; code: string; name: string | null } | null;
    isLeadClass: boolean;
    lesson: { id: string; title: string; sequence: number; revision: number; confirmedAt: string | null; revisions: Array<{ id: string; revision: number; confirmedAt: string }>; draftMaterial: LessonFeedbackMaterial; confirmedMaterial: LessonFeedbackMaterial | null; hasUnconfirmedChanges: boolean } | null;
    status: "linked" | "independent" | "lead_required";
  } | null;
  sessionCommonMaterial?: { material: LessonFeedbackMaterial; confirmedAt: string | null } | null;
  total: number;
  students: FeedbackContextStudent[];
  routing?: Array<{
    studentId: string;
    baseline: Exclude<FeedbackIntensity, "manual">;
    intensity: FeedbackIntensity;
    reasons: FeedbackRoutingReason[];
  }>;
}

export interface FeedbackStudentOption {
  id: string;
  name: string;
  class: string;
  studentId?: string;
}
