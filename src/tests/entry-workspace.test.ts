import { describe, expect, it } from "vitest";
import { isInputWorkspaceState, isReviewWorkspaceState, reviewedStudentCount } from "@/features/entry/workspace-state";

describe("entry workspace state", () => {
  it("accepts the existing input workspace envelope", () => {
    expect(isInputWorkspaceState({
      context: { semesterId: "semester", className: "class", sessionCode: "session" },
      rawText: "课堂记录",
      result: null,
    })).toBe(true);
    expect(isInputWorkspaceState({ context: null, rawText: "", result: null })).toBe(false);
  });

  it("accepts review edits and rejects invalid filters", () => {
    const valid = { edits: {}, expandedId: null, filterStatus: "pending", filterClass: "" };
    expect(isReviewWorkspaceState(valid)).toBe(true);
    expect(isReviewWorkspaceState({ ...valid, filterStatus: "unknown" })).toBe(false);
  });

  it("counts each reviewed student only once", () => {
    const draft = {
      reviewResult: {
        is_valid: false,
        issues: ["需要复核"],
        suggestions: [],
        revised_scores: { 甲: { A: 4 }, 乙: { B: 3 } },
        revised_events: { 甲: ["课堂表现"] },
      },
    };
    expect(reviewedStudentCount(draft)).toBe(2);
  });
});
