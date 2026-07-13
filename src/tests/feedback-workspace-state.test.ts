import { describe, expect, it } from "vitest";
import { isFeedbackWorkspace, todayLocalDate } from "@/features/feedback/workspace-state";

function workspaceState() {
  return {
    context: { semesterId: "semester", className: "class", sessionCode: "session" },
    newSessionDate: "2026-07-14",
    rawText: "课堂记录",
    parseStatus: "",
    streamContent: "",
    draftId: "",
    parsedResult: null,
    reviewResult: null,
    corrections: [],
    confirmed: false,
    status: "",
    feedbackCards: [],
    feedbackTotal: 0,
    feedbackDone: 0,
    feedbackDirty: false,
    forceRegenerate: false,
    singleStudentId: "",
    singleDays: 14,
    singleFeedback: "",
  };
}

describe("feedback workspace state", () => {
  it("keeps the existing workspace format valid", () => {
    expect(isFeedbackWorkspace(workspaceState())).toBe(true);
    expect(isFeedbackWorkspace({ ...workspaceState(), feedbackDone: "0" })).toBe(false);
  });

  it("formats local dates without UTC rollover", () => {
    expect(todayLocalDate(new Date(2026, 6, 4, 23, 30))).toBe("2026-07-04");
  });
});
