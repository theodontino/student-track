import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  feedbackPlanBatchDisplayState,
  feedbackPlanDisplayState,
  feedbackPlanManagerStatusText,
  shouldPollFeedbackPlanTask,
  shouldPollFeedbackPlanTasks,
  type FeedbackPlanBatchSummary,
  type FeedbackPlanSummary,
} from "@/features/feedback/FeedbackPlanManager";
import { FeedbackFactFreezeIndicator } from "@/features/feedback/FeedbackTaskDocumentStage";

function plan(patch: Partial<FeedbackPlanSummary> = {}): FeedbackPlanSummary {
  return {
    id: "plan-a",
    type: "event_micro",
    status: "draft",
    itemStatusCounts: { total: 2, queued: 0, running: 0, completed: 0, failed: 0 },
    ...patch,
  };
}

function batch(patch: Partial<FeedbackPlanBatchSummary> = {}): FeedbackPlanBatchSummary {
  return {
    id: "batch-a",
    type: "event_micro",
    status: "draft",
    plans: [],
    progress: { total: 4, generated: 0, approved: 0, exported: 0, failed: 0, completedClasses: 0, totalClasses: 2 },
    ...patch,
  };
}

describe("feedback plan manager state", () => {
  it("distinguishes saved, active and completed plans", () => {
    expect(feedbackPlanDisplayState(plan())).toBe("saved");
    expect(feedbackPlanDisplayState(plan({
      status: "generating",
      itemStatusCounts: { total: 2, queued: 1, running: 1, completed: 0, failed: 0 },
    }))).toBe("active");
    expect(feedbackPlanDisplayState(plan({
      status: "in_review",
      itemStatusCounts: { total: 2, queued: 0, running: 0, completed: 2, failed: 0 },
    }))).toBe("completed");
  });

  it("polls only while the current plan or batch can still change automatically", () => {
    const queuedPlan = plan({ status: "queued", itemStatusCounts: { total: 2, queued: 2, running: 0, completed: 0, failed: 0 } });
    const pausedPlan = plan({ status: "paused", itemStatusCounts: { total: 2, queued: 1, running: 0, completed: 1, failed: 0 } });
    const runningBatch = batch({ status: "running" });
    const failedBatch = batch({ status: "generation_failed", progress: { ...batch().progress, failed: 1 } });

    expect(shouldPollFeedbackPlanTask({ kind: "plan", id: queuedPlan.id, plan: queuedPlan })).toBe(true);
    expect(shouldPollFeedbackPlanTask({ kind: "plan", id: pausedPlan.id, plan: pausedPlan })).toBe(false);
    expect(shouldPollFeedbackPlanTask({ kind: "batch", id: runningBatch.id, batch: runningBatch })).toBe(true);
    expect(shouldPollFeedbackPlanTask({ kind: "batch", id: failedBatch.id, batch: failedBatch })).toBe(false);
  });

  it("keeps polling when any visible task is active and describes an unselected list honestly", () => {
    const savedPlan = plan();
    const runningPlan = plan({ id: "plan-running", status: "generating", itemStatusCounts: { total: 2, queued: 1, running: 1, completed: 0, failed: 0 } });
    const tasks = [
      { kind: "plan" as const, id: savedPlan.id, plan: savedPlan },
      { kind: "plan" as const, id: runningPlan.id, plan: runningPlan },
    ];
    expect(shouldPollFeedbackPlanTasks(tasks)).toBe(true);
    expect(feedbackPlanManagerStatusText(tasks, null)).toBe("2 个未归档计划 · 1 个活动中");
    expect(feedbackPlanManagerStatusText([], null)).toBe("尚未建立反馈计划");
  });

  it("distinguishes saved, active and completed batches", () => {
    expect(feedbackPlanBatchDisplayState(batch())).toBe("saved");
    expect(feedbackPlanBatchDisplayState(batch({ status: "running" }))).toBe("active");
    expect(feedbackPlanBatchDisplayState(batch({
      status: "completed",
      progress: { ...batch().progress, generated: 4, completedClasses: 2 },
    }))).toBe("completed");
  });
});

describe("feedback fact freeze indicator", () => {
  it("announces completed and unfinished frozen snapshots as semantic status lights", () => {
    const completed = renderToStaticMarkup(<FeedbackFactFreezeIndicator complete />);
    const unfinished = renderToStaticMarkup(<FeedbackFactFreezeIndicator complete={false} />);

    expect(completed).toContain('role="status"');
    expect(completed).toContain('aria-label="已完成反馈生成 · 事实已冻结"');
    expect(completed).toContain("factFreezeComplete");
    expect(unfinished).toContain('aria-label="未完成反馈生成 · 事实已冻结"');
    expect(unfinished).toContain("factFreezeIncomplete");
  });
});
