import { describe, expect, it } from "vitest";
import { isCardScore, isQuickScoreSessionState } from "@/features/quick-score/workspace-state";

const card = {
  studentId: "student-1",
  studentName: "测试学生",
  scoreA: 3,
  scoreB: 4,
  scoreC: 2,
  present: true,
  note: "",
};

describe("quick-score workspace state", () => {
  it("accepts the compatible card format", () => {
    expect(isCardScore(card)).toBe(true);
    expect(isCardScore({ ...card, present: "true" })).toBe(false);
  });

  it("requires teaching context, date, and valid cards", () => {
    const state = {
      context: { semesterId: "semester-1", className: "一班", sessionCode: "session-1" },
      date: "2026-07-14",
      cards: [card],
    };
    expect(isQuickScoreSessionState(state)).toBe(true);
    expect(isQuickScoreSessionState({ ...state, cards: [{ ...card, scoreA: null }] })).toBe(false);
  });
});
