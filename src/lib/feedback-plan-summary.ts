export const FEEDBACK_PLAN_ACTION_BUCKETS = ["generating", "needs_continue", "completed"] as const;
export type FeedbackPlanActionBucket = typeof FEEDBACK_PLAN_ACTION_BUCKETS[number];

export type FeedbackPlanItemStatusCounts = {
  total: number;
  evidenceReady: number;
  queued: number;
  running: number;
  paused: number;
  failed: number;
  needsReview: number;
  approved: number;
  exported: number;
  stale: number;
  completed: number;
};

export function feedbackPlanItemStatusCounts(items: Array<{ status: string }>): FeedbackPlanItemStatusCounts {
  const counts = items.reduce<Record<string, number>>((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  const needsReview = counts.needs_review ?? 0;
  const approved = counts.approved ?? 0;
  const exported = counts.exported ?? 0;
  return {
    total: items.length,
    evidenceReady: counts.evidence_ready ?? 0,
    queued: counts.queued ?? 0,
    running: counts.generating ?? 0,
    paused: counts.paused ?? 0,
    failed: counts.generation_failed ?? 0,
    needsReview,
    approved,
    exported,
    stale: counts.stale ?? 0,
    completed: needsReview + approved + exported,
  };
}

export function feedbackPlanActionBucket(
  status: string,
  counts: FeedbackPlanItemStatusCounts,
  kind: "plan" | "batch" = "plan",
): FeedbackPlanActionBucket {
  const needsContinueStatuses = kind === "batch"
    ? new Set(["paused", "failed"])
    : new Set(["paused", "generation_failed", "in_review", "partially_approved", "stale"]);
  const runningStatuses = kind === "batch"
    ? new Set(["queued", "running", "pause_requested"])
    : new Set(["queued", "generating", "pause_requested"]);
  if (needsContinueStatuses.has(status)) return "needs_continue";
  if (runningStatuses.has(status) || counts.running > 0 || counts.queued > 0) return "generating";
  if (counts.total > 0 && counts.approved + counts.exported === counts.total) return "completed";
  return "needs_continue";
}
