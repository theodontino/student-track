const FEEDBACK_PLAN_GENERATED_STATUSES = new Set([
  "queued",
  "generating",
  "pause_requested",
  "paused",
  "generation_failed",
  "in_review",
  "partially_approved",
  "approved",
  "partially_exported",
  "exported",
]);

export function feedbackPlanItemHasGeneratedResult(item: {
  status: string;
  finalText: string | null;
  selectedGenerationId: string | null;
  approvedAt: Date | null;
  exportedAt: Date | null;
}) {
  return Boolean(item.finalText || item.selectedGenerationId || item.approvedAt || item.exportedAt)
    || ["needs_review", "approved", "exported"].includes(item.status);
}

export function feedbackPlanHasGenerationTrace(plan: {
  status: string;
  generationStartedAt: Date | null;
  generationCompletedAt: Date | null;
  items: Array<{
    status: string;
    finalText: string | null;
    selectedGenerationId: string | null;
    approvedAt: Date | null;
    exportedAt: Date | null;
  }>;
}) {
  return Boolean(plan.generationStartedAt || plan.generationCompletedAt)
    || FEEDBACK_PLAN_GENERATED_STATUSES.has(plan.status)
    || plan.items.some((item) => (
      feedbackPlanItemHasGeneratedResult(item)
      || ["queued", "generating", "pause_requested", "paused", "generation_failed"].includes(item.status)
    ));
}
