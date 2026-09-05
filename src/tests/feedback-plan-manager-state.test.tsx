import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  feedbackPlanBatchDisplayState,
  feedbackPlanDisplayState,
  feedbackPlanManagerStatusText,
  feedbackPlanTaskActionBucket,
  feedbackPlanTaskGenerationApproachLabel,
  feedbackPlanTaskIsCurrent,
  feedbackPlanTaskPrimaryActionLabel,
  groupFeedbackPlanTasks,
  shouldPollFeedbackPlanTask,
  shouldPollFeedbackPlanTasks,
  type FeedbackPlanBatchSummary,
  type FeedbackPlanSummary,
} from "@/features/feedback/FeedbackPlanManager";
import {
  FeedbackFactFreezeIndicator,
  feedbackDocumentUsesRetiredLegacyGeneration,
  feedbackSaveAsInitialGenerationApproach,
} from "@/features/feedback/FeedbackTaskDocumentStage";

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
  it("treats only the stored legacy identity as retired, independent of the historical mode", () => {
    expect(feedbackDocumentUsesRetiredLegacyGeneration({
      batch: null,
      plans: [{ generationApproach: "free", legacyReadonly: false }],
    })).toBe(false);
    expect(feedbackDocumentUsesRetiredLegacyGeneration({
      batch: null,
      plans: [{ generationApproach: null, legacyReadonly: true }],
    })).toBe(true);
    expect(feedbackDocumentUsesRetiredLegacyGeneration({
      batch: null,
      plans: [{ generationApproach: null, legacyReadonly: false }],
    })).toBe(false);
  });
  it("requires a legacy document to choose a current generation approach when saving as", () => {
    expect(feedbackSaveAsInitialGenerationApproach(null)).toBe("");
    expect(feedbackSaveAsInitialGenerationApproach("restricted")).toBe("restricted");
    expect(feedbackSaveAsInitialGenerationApproach("free")).toBe("free");
  });
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

  it("labels restricted, free and historical generation approaches in the visible task rows", () => {
    const restrictedPlan = plan({ generationApproach: "restricted" });
    const freeBatch = batch({ generationApproach: "free" });
    const legacyPlan = plan({ id: "plan-legacy", generationApproach: null, legacyReadonly: true });
    const unmarkedPlan = plan({ id: "plan-unmarked", generationApproach: null });

    expect(feedbackPlanTaskGenerationApproachLabel({ kind: "plan", id: restrictedPlan.id, plan: restrictedPlan })).toBe("受限反馈");
    expect(feedbackPlanTaskGenerationApproachLabel({ kind: "batch", id: freeBatch.id, batch: freeBatch })).toBe("自由反馈");
    expect(feedbackPlanTaskGenerationApproachLabel({ kind: "plan", id: legacyPlan.id, plan: legacyPlan })).toBe("旧生成方式");
    expect(feedbackPlanTaskGenerationApproachLabel({ kind: "plan", id: unmarkedPlan.id, plan: unmarkedPlan })).toBe("生成方式未标注");
  });

  it("resolves a current child plan to its single batch row", () => {
    const currentBatch = batch({
      plans: [{ id: "plan-child", class: { id: "class-a", code: "A" }, session: { code: "S1" } }],
      actionBucket: "needs_continue",
    });
    const batchRow = { kind: "batch" as const, id: currentBatch.id, batch: currentBatch };
    const child = plan({ id: "plan-child", batchId: currentBatch.id, actionBucket: "needs_continue" });
    const childRow = { kind: "plan" as const, id: child.id, plan: child };
    const groups = groupFeedbackPlanTasks([batchRow, childRow], child.id);

    expect(feedbackPlanTaskIsCurrent(batchRow, child.id)).toBe(true);
    expect(groups.current).toBe(batchRow);
    expect([...groups.generating, ...groups.needsContinue, ...groups.completed].map((task) => task.id)).not.toContain(child.id);
  });

  it("uses server action buckets and sorts each group by latest update", () => {
    const pausedWithQueue = plan({
      id: "paused",
      status: "paused",
      updatedAt: "2026-09-05T03:00:00.000Z",
      itemStatusCounts: { total: 2, queued: 1, running: 0, completed: 1, failed: 0 },
    });
    const failed = plan({ id: "failed", status: "generation_failed", updatedAt: "2026-09-05T02:00:00.000Z" });
    const running = plan({ id: "running", status: "generating", updatedAt: "2026-09-05T01:00:00.000Z", actionBucket: "generating" });
    const rows = [pausedWithQueue, failed, running].map((record) => ({ kind: "plan" as const, id: record.id, plan: record }));
    const groups = groupFeedbackPlanTasks(rows);

    expect(feedbackPlanTaskActionBucket(rows[0])).toBe("needs_continue");
    expect(groups.needsContinue.map((task) => task.id)).toEqual(["paused", "failed"]);
    expect(groups.generating.map((task) => task.id)).toEqual(["running"]);
  });

  it("caps recently completed at five after callers apply search", () => {
    const completedRows = Array.from({ length: 7 }, (_, index) => {
      const record = plan({
        id: `completed-${index}`,
        displayName: index === 6 ? "目标计划" : `普通计划 ${index}`,
        updatedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
        actionBucket: "completed",
      });
      return { kind: "plan" as const, id: record.id, plan: record };
    });

    expect(groupFeedbackPlanTasks(completedRows).completed.map((task) => task.id)).toEqual([
      "completed-6", "completed-5", "completed-4", "completed-3", "completed-2",
    ]);
    expect(groupFeedbackPlanTasks(completedRows.filter((task) => task.plan.displayName === "目标计划")).completed.map((task) => task.id)).toEqual(["completed-6"]);
  });

  it("shows legacy review only from the explicit read-only identity", () => {
    const legacy = plan({ generationApproach: null, legacyReadonly: true });
    const unmarkedNull = plan({ id: "unmarked", generationApproach: null, legacyReadonly: false });
    expect(feedbackPlanTaskPrimaryActionLabel({ kind: "plan", id: legacy.id, plan: legacy })).toBe("复核已有正文");
    expect(feedbackPlanTaskPrimaryActionLabel({ kind: "plan", id: unmarkedNull.id, plan: unmarkedNull })).toBe("继续规划");
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
