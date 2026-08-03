import { describe, expect, it } from "vitest";
import { selectQuickScoreSession, shouldApplyQuickScoreRequest } from "@/features/quick-score/session-helpers";
import { hasQuickScoreCardChanged, type OriginalScore } from "@/features/quick-score/useQuickScoreWorkspace";
import type { CardScore, SessionInfo } from "@/lib/types";

const sessions: SessionInfo[] = [
  { id: "first", code: "S-1", semesterNumber: 1, date: "2026-07-14", class: "一班", attendanceCount: 2 },
  { id: "today", code: "S-2", semesterNumber: 2, date: "2026-07-15", class: "一班", attendanceCount: 2 },
];

const card: CardScore = {
  studentId: "student-1",
  studentName: "测试学生",
  scoreA: 3,
  scoreB: 3,
  scoreC: 3,
  present: true,
  note: "",
};

const original: OriginalScore = { scoreA: 3, scoreB: 3, scoreC: 3, present: true };

describe("quick-score request and recovery helpers", () => {
  it("uses a restored session before today's or the first session", () => {
    expect(selectQuickScoreSession(sessions, "S-1", "2026-07-15")?.code).toBe("S-1");
  });

  it("falls back from a missing restored session to today's session, then the first", () => {
    expect(selectQuickScoreSession(sessions, "missing", "2026-07-15")?.code).toBe("S-2");
    expect(selectQuickScoreSession(sessions, "missing", "2099-01-01")?.code).toBe("S-1");
    expect(selectQuickScoreSession([], "missing", "2099-01-01")).toBeNull();
  });

  it("rejects an older response or a response for a previous teaching context", () => {
    const current = {
      requestId: 2,
      latestRequestId: 2,
      requestedSemesterId: "semester-1",
      currentSemesterId: "semester-1",
      requestedClassId: "class-1",
      currentClassId: "class-1",
      requestedClassName: "一班",
      currentClassName: "一班",
    };
    expect(shouldApplyQuickScoreRequest(current)).toBe(true);
    expect(shouldApplyQuickScoreRequest({ ...current, requestId: 1 })).toBe(false);
    expect(shouldApplyQuickScoreRequest({ ...current, currentSemesterId: "semester-2" })).toBe(false);
    expect(shouldApplyQuickScoreRequest({ ...current, currentClassId: "class-2" })).toBe(false);
    expect(shouldApplyQuickScoreRequest({ ...current, currentClassName: "二班" })).toBe(false);
  });

  it("submits only actual differences, including attendance and notes", () => {
    expect(hasQuickScoreCardChanged(card, original)).toBe(false);
    expect(hasQuickScoreCardChanged({ ...card, scoreA: 4 }, original)).toBe(true);
    expect(hasQuickScoreCardChanged({ ...card, present: false }, original)).toBe(true);
    expect(hasQuickScoreCardChanged({ ...card, note: "需关注" }, original)).toBe(true);
    expect(hasQuickScoreCardChanged(card)).toBe(false);
    expect(hasQuickScoreCardChanged({ ...card, scoreC: 5 })).toBe(true);
  });
});
