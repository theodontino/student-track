import { describe, expect, it } from "vitest";
import {
  extractFeedbackDateRange,
  relativeFeedbackDateLabel,
  replaceFeedbackDatesWithRelativeLabels,
} from "@/lib/feedback-time";

describe("feedback time semantics", () => {
  it("keeps a cross-day evidence range instead of selecting the latest day", () => {
    expect(extractFeedbackDateRange("2026-07-20至2026-07-21")).toEqual({ start: "2026-07-20", end: "2026-07-21" });
    expect(relativeFeedbackDateLabel("2026-07-21", "2026-07-20至2026-07-21")).toBe("昨天至今天");
  });

  it("renders model-facing dates relatively without changing non-date content", () => {
    const rendered = replaceFeedbackDatesWithRelativeLabels(
      "2026-07-20 的沟通与 2026-07-21 的课堂表现需要区分。",
      "2026-07-21",
    );
    expect(rendered).toBe("昨天 的沟通与 今天 的课堂表现需要区分。");
    expect(rendered).not.toContain("2026-07-20");
    expect(rendered).not.toContain("2026-07-21");
  });

  it("renders a historical cross-day range as one relative period", () => {
    expect(replaceFeedbackDatesWithRelativeLabels(
      "沟通发生在 2026-07-20至2026-07-21。",
      "2026-07-21",
    )).toBe("沟通发生在 昨天至今天。");
  });
});
