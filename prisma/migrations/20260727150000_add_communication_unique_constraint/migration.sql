-- Add composite unique constraint on Communication(studentId, sessionId, summary)
-- to prevent duplicate feedback entries from re-runs of WCC handoff or LLM pre-review.
CREATE UNIQUE INDEX IF NOT EXISTS "communication_student_session_summary_key"
  ON "Communication"("studentId", "sessionId", "summary");
