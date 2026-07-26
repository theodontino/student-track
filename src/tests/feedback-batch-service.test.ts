import { describe, expect, it } from "vitest";
import { feedbackBatchConcurrency, feedbackBatchWindows } from "@/services/feedback-batch-service";

describe("feedback batch helpers", () => {
  it("clamps concurrency and keeps window order", () => {
    expect(feedbackBatchConcurrency({ NODE_ENV: "production", FEEDBACK_LLM_CONCURRENCY: "99" })).toBe(3);
    expect(feedbackBatchWindows(["a", "b", "c", "d", "e"], 2)).toEqual([
      [{ item: "a", index: 0 }, { item: "b", index: 1 }],
      [{ item: "c", index: 2 }, { item: "d", index: 3 }],
      [{ item: "e", index: 4 }],
    ]);
  });
});
