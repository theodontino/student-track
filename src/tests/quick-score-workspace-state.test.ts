import { describe, expect, it } from "vitest";
import { isCardScore, isQuickScoreSessionState } from "@/features/quick-score/workspace-state";
import { quickScorePayload, quickScoreChanges, rebaseQuickScoreCards } from "@/features/quick-score/score-changes";

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
  it("submits only changed dimensions and separates attendance from scores", () => {
    const original = { ...card, scoreA: 4.2 };
    const originals = new Map([[card.studentId, original]]);
    expect(quickScorePayload([{ ...original, scoreB: 5 }], originals, "2099-01-01", "test-session")).toEqual({
      scores: [{ studentId: card.studentId, date: "2099-01-01", scoreB: 5 }], attendances: [], sessionCode: "test-session",
    });
    expect(quickScorePayload([{ ...original, present: false }], originals, "2099-01-01", "test-session")).toMatchObject({ scores: [], attendances: [{ studentId: card.studentId, present: false }] });
    expect(quickScoreChanges(original, original)).toEqual({});
    expect(quickScoreChanges({ ...original, scoreA: 4 }, original)).toEqual({ scoreA: 4 });
    expect(quickScoreChanges({ ...original, note: " " }, original)).toEqual({});
  });

  it("rebases an unsaved B change on the latest PDF A without restoring stale fields", () => {
    const baseline = { ...card, scoreA: 3 };
    const latest = { ...card, scoreA: 4.2, scoreC: 5 };
    expect(rebaseQuickScoreCards([latest], [{ ...baseline, scoreB: 5 }], { [card.studentId]: baseline })).toEqual([{ ...latest, scoreB: 5 }]);
  });

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
