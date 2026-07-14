import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuickScoreSession,
  deleteQuickScoreSession,
  loadQuickScoreReferenceData,
  loadQuickScoreSession,
  loadQuickScoreSessions,
  saveQuickScores,
} from "@/features/quick-score/api";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("quick score API boundary", () => {
  it("loads reference data through the shared JSON client", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "student-1", name: "张三", class: "测试班", gender: "男" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "semester-1", name: "测试学期", startDate: "2026-01-01", endDate: "2026-06-30", sessionCount: 1 }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadQuickScoreReferenceData()).resolves.toMatchObject({
      students: [{ id: "student-1" }],
      semesters: [{ id: "semester-1" }],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/students", undefined);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/semesters", undefined);
  });

  it("encodes session selectors and normalizes API failures", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ scores: [] }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ error: "课次不存在" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await loadQuickScoreSession("高一 1 班", "S/01");
    await loadQuickScoreSessions("semester/1", "高一 1 班");
    await expect(deleteQuickScoreSession("semester/1", "S/01")).rejects.toMatchObject({
      status: 404,
      message: "课次不存在",
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/quick-score?class=%E9%AB%98%E4%B8%80+1+%E7%8F%AD&sessionCode=S%2F01");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sessions?semesterId=semester%2F1&className=%E9%AB%98%E4%B8%80+1+%E7%8F%AD");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/semesters/semester%2F1/session?code=S%2F01");
  });

  it("uses explicit JSON requests for create and save", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: "session-1", code: "S01" }, 201))
      .mockResolvedValueOnce(jsonResponse({ count: 1, attUpdated: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await createQuickScoreSession("semester-1", "测试班");
    await saveQuickScores({
      scores: [{ studentId: "student-1", date: "2026-01-01", scoreA: 4, scoreB: 4, scoreC: 4 }],
      sessionCode: "S01",
      attendances: [{ studentId: "student-1", present: true }],
    });

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ sessionCode: "S01" });
  });
});
