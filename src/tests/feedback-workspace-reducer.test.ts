import { describe, expect, it } from "vitest";
import {
  createFeedbackWorkspaceCoreState,
  feedbackCardsReducer,
  feedbackWorkspaceCoreReducer,
} from "@/features/feedback/feedback-workspace-reducer";

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
});
