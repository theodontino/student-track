import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  historyCreate: vi.fn(),
  completionCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    classSession: {
      findUnique: vi.fn().mockResolvedValue({
        id: "session-1",
        code: "VITEST-STREAM",
        date: "2026-06-14",
        semesterNumber: 1,
        classId: "class-1",
        class: { name: "测试班", code: "T-1" },
      }),
    },
    student: {
      findMany: vi.fn().mockResolvedValue([
        { id: "student-1", name: "学生甲", studentLabels: [] },
        { id: "student-2", name: "学生乙", studentLabels: [] },
      ]),
    },
    sessionMetric: { findMany: vi.fn().mockResolvedValue([]) },
    attendance: { findMany: vi.fn().mockResolvedValue([]) },
    event: { findMany: vi.fn().mockResolvedValue([]) },
    workHistory: { create: mocks.historyCreate, findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({ chat: { completions: { create: mocks.completionCreate } } }),
  getLLMModel: () => "test-model",
}));

import { POST } from "@/app/api/report/feedback-batch/route";

describe("feedback batch NDJSON stream", () => {
  beforeEach(() => {
    mocks.historyCreate.mockReset().mockResolvedValue({ id: "history-1" });
    mocks.completionCreate.mockReset()
      .mockResolvedValueOnce({ choices: [{ message: { content: "甲反馈" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "乙反馈" } }] });
  });

  it("streams progress by studentId, persists final cards, and returns full cached data", async () => {
    const request = () => new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionCode: "VITEST-STREAM", historyModule: "feedback" }),
    });

    const response = await POST(request());
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events.map((event) => event.type)).toEqual(["init", "progress", "progress", "done"]);
    expect(events[1]).toMatchObject({ studentId: "student-1", name: "学生甲", feedback: "甲反馈" });
    expect(events[2]).toMatchObject({ studentId: "student-2", name: "学生乙", feedback: "乙反馈" });
    expect(events[3].students).toEqual([
      expect.objectContaining({ id: "student-1", feedback: "甲反馈" }),
      expect.objectContaining({ id: "student-2", feedback: "乙反馈" }),
    ]);
    expect(mocks.historyCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ module: "feedback", key: "VITEST-STREAM" }),
    }));

    const cached = await POST(request());
    expect(cached.headers.get("content-type")).toContain("application/json");
    await expect(cached.json()).resolves.toMatchObject({
      cached: true,
      total: 2,
      students: [
        expect.objectContaining({ id: "student-1", feedback: "甲反馈" }),
        expect.objectContaining({ id: "student-2", feedback: "乙反馈" }),
      ],
    });
  });
});
