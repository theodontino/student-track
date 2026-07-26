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
    expect(isFeedbackWorkspace({ ...workspaceState(), activeStep: "review" })).toBe(true);
    expect(isFeedbackWorkspace({ ...workspaceState(), activeStep: "unknown" })).toBe(false);
    expect(isFeedbackWorkspace({ ...workspaceState(), feedbackDone: "0" })).toBe(false);
  });

  it("accepts restored course materials and parsed assessment evidence", () => {
    const state = {
      ...workspaceState(),
      groupFeedbackRaw: "群反馈",
      assessmentBriefRaw: "测验说明",
      lessonMaterial: {
        version: 1,
        groupFeedbackRaw: "群反馈",
        assessmentBriefRaw: "测验说明",
        lessonTitle: "测试课",
        classroomContent: ["内容"],
        classroomFocus: [],
        classroomExplanation: [],
        homework: [],
        assessmentFocus: [],
        correctionAdvice: [],
        otherNotes: [],
      },
      assessmentImports: [],
    };
    expect(isFeedbackWorkspace(state)).toBe(true);
  });

  it("formats local dates without UTC rollover", () => {
    expect(todayLocalDate(new Date(2026, 6, 4, 23, 30))).toBe("2026-07-04");
  });
});
