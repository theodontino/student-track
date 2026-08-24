/** Client-safe intake rules shared by the review UI and server services. */
export type FeedbackIntakeIssueSeverity = "requires_teacher" | "error";

const NON_BLOCKING_CODES = new Set([
  "assistant_date_missing",
  "assistant_lesson_missing",
  "assessment_date_missing",
  "duplicate_student",
  "student_id_fallback",
  "assessment_student_id_fallback",
]);

export function isBlockingFeedbackIntakeIssue(item: { code: string; severity: FeedbackIntakeIssueSeverity }) {
  if (NON_BLOCKING_CODES.has(item.code)) return false;
  return item.severity === "error" || [
    "assistant_date_mismatch",
    "assistant_lesson_mismatch",
    "step_date_missing",
    "step_date_mismatch",
    "assessment_date_mismatch",
    "student_identity_conflict",
    "student_mismatch",
    "step_student_mismatch",
    "assessment_student_mismatch",
    "assessment_identity_conflict",
    "assessment_needs_match",
    "assessment_duplicate",
    "attendance_conflict",
    "score_conflict",
    "zip_invalid",
    "assistant_invalid",
    "step_invalid",
    "assessment_invalid",
    "step_note_review",
  ].includes(item.code);
}
