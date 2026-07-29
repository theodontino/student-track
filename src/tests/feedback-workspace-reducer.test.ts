import { describe, expect, it } from "vitest";
import {
  createFeedbackWorkspaceCoreState,
  feedbackCardsReducer,
  feedbackWorkspaceCoreReducer,
} from "@/features/feedback/feedback-workspace-reducer";
import {
  emptyFeedbackBatchProgress,
  feedbackBatchCanExport,
  remainingFeedbackStudentIds,
  restoreFeedbackBatchProgress,
  updateStudentProgress,
} from "@/features/feedback/feedback-batch-progress";

describe("feedback workspace reducer", () => {
  it("keeps workflow changes explicit and bounded", () => {
    let core = createFeedbackWorkspaceCoreState();
    core = feedbackWorkspaceCoreReducer(core, { type: "patch", patch: { rawText: "课堂记录" } });
    core = feedbackWorkspaceCoreReducer(core, { type: "stream/append", content: "片段一" });
    core = feedbackWorkspaceCoreReducer(core, { type: "stream/append", content: "片段二" });
    expect(core.rawText).toBe("课堂记录");
    expect(core.streamContent).toBe("片段一片段二");

    let cards = feedbackCardsReducer(
      { cards: [], total: 0, done: 0, dirty: false, forceRegenerate: false },
      { type: "init", cards: [{ id: "1", name: "甲", labels: [], feedback: "" }], total: 1 },
    );
    cards = feedbackCardsReducer(cards, { type: "progress", done: 99 });
    expect(cards.done).toBe(1);
    cards = feedbackCardsReducer(cards, { type: "patch", studentId: "1", patch: { feedback: "已完成" } });
    expect(cards.cards[0].feedback).toBe("已完成");
  });

  it("restores running work as incomplete and keeps duplicate events idempotent", () => {
    const cards = [
      { id: "1", name: "甲", labels: [], feedback: "已完成" },
      { id: "2", name: "乙", labels: [], feedback: "" },
    ];
    const restored = restoreFeedbackBatchProgress({
      saved: {
        ...emptyFeedbackBatchProgress(),
        status: "running",
        phase: "review",
        inputRevision: "revision-1",
        total: 2,
        completedStudentIds: ["1", "1"],
      },
      cards,
      total: 2,
      legacyDone: 1,
    });
    expect(restored).toMatchObject({
      status: "incomplete",
      completedStudentIds: ["1"],
      interruptionReason: "页面刷新或离开时批次仍在运行",
    });
    expect(remainingFeedbackStudentIds(cards, restored)).toEqual(["2"]);

    const once = updateStudentProgress(restored, "2", "completed");
    const duplicate = updateStudentProgress(once, "2", "completed");
    expect(duplicate.completedStudentIds).toEqual(["1", "2"]);
    expect(feedbackBatchCanExport(duplicate, false)).toBe(false);
    expect(feedbackBatchCanExport({ ...duplicate, status: "completed", phase: "completed" }, false)).toBe(true);
    expect(feedbackBatchCanExport({ ...duplicate, status: "completed", phase: "completed" }, true)).toBe(false);
  });
});
