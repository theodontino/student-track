import { describe, expect, it } from "vitest";
import {
  feedbackPlanActionBucket,
  feedbackPlanItemStatusCounts,
} from "@/lib/feedback-plan-summary";
import { toFeedbackPlanBatchView } from "@/services/feedback-plan-batch-service";

describe("feedback plan derived summary", () => {
  it("keeps approved and exported as disjoint item counts", () => {
    expect(feedbackPlanItemStatusCounts([
      { status: "needs_review" },
      { status: "approved" },
      { status: "exported" },
    ])).toEqual({
      total: 3,
      evidenceReady: 0,
      queued: 0,
      running: 0,
      paused: 0,
      failed: 0,
      needsReview: 1,
      approved: 1,
      exported: 1,
      stale: 0,
      completed: 3,
    });
  });

  it("groups paused or failed work with queued items under needs continue", () => {
    const queued = feedbackPlanItemStatusCounts([{ status: "queued" }, { status: "needs_review" }]);
    expect(feedbackPlanActionBucket("paused", queued)).toBe("needs_continue");
    expect(feedbackPlanActionBucket("failed", queued, "batch")).toBe("needs_continue");
  });

  it("separates active generation from fully handled work", () => {
    const active = feedbackPlanItemStatusCounts([{ status: "generating" }, { status: "queued" }]);
    const handled = feedbackPlanItemStatusCounts([{ status: "approved" }, { status: "exported" }]);
    expect(feedbackPlanActionBucket("generating", active)).toBe("generating");
    expect(feedbackPlanActionBucket("approved", handled)).toBe("completed");
  });

  it("aggregates batch item states once and keeps failed batches out of generating", () => {
    const batch = toFeedbackPlanBatchView({
      status: "failed",
      generationApproach: "restricted",
      exportRuns: [{ itemManifest: '[{"itemId":"item-exported"}]' }],
      plans: [{
        status: "paused",
        type: "event_micro",
        inputSnapshot: "{}",
        generationApproach: "restricted",
        items: [
          { id: "item-approved", status: "approved" },
          { id: "item-exported", status: "exported" },
          { id: "item-queued", status: "queued" },
        ],
      }],
    });

    expect(batch.itemStatusCounts).toMatchObject({
      total: 3,
      queued: 1,
      approved: 1,
      exported: 1,
      completed: 2,
    });
    expect(batch.progress).toMatchObject({ total: 3, generated: 2, approved: 2, exported: 1 });
    expect(batch.actionBucket).toBe("needs_continue");
    expect(batch.plans[0]?.actionBucket).toBe("needs_continue");
  });
});
