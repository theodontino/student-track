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

vi.mock("@/services/feedback-context-service", () => ({
  buildFeedbackContext: vi.fn().mockResolvedValue({
    session: {
      id: "session-1",
      code: "VITEST-STREAM",
      date: "2026-06-14",
      semesterId: "semester-1",
      semesterNumber: 1,
      classId: "class-1",
    },
    className: "测试班",
    total: 2,
    students: [
      {
        id: "student-1",
        name: "学生甲",
        studentId: "S1",
        labels: ["#稳定"],
        promptContext: "学生甲上下文：学生标签：#稳定\n近期趋势：A4/B4/C4/D5\n近期家校沟通：与母亲：希望多强调进步",
        preview: {
          today: ["学习&测验 4分"],
          trend: "A4/B4/C4/D5",
          communications: ["与母亲：希望多强调进步"],
          labels: ["#稳定"],
        },
      },
      {
        id: "student-2",
        name: "学生乙",
        studentId: "S2",
        labels: [],
        promptContext: "学生乙上下文：近期趋势：暂无近期评分趋势\n近期家校沟通：无",
        preview: {
          today: ["学习&测验 无记录"],
          trend: "暂无近期评分趋势",
          communications: [],
          labels: [],
        },
      },
    ],
  }),
}));

import { POST } from "@/app/api/report/feedback-batch/route";

describe("feedback batch NDJSON stream", () => {
  beforeEach(() => {
    mocks.historyCreate.mockReset().mockResolvedValue({ id: "history-1" });
    mocks.completionCreate.mockReset()
      .mockResolvedValueOnce({ choices: [{ message: { content: "甲反馈" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "乙反馈" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ verdict: "pass", feedback: "甲反馈", issues: [] }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ verdict: "pass", feedback: "乙反馈", issues: [] }) } }] });
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

    expect(events.map((event) => event.type)).toEqual(["init", "draft", "draft", "review", "review", "done"]);
    expect(events[0].students[0]).toMatchObject({
      id: "student-1",
      contextPreview: expect.objectContaining({
        trend: "A4/B4/C4/D5",
        communications: ["与母亲：希望多强调进步"],
      }),
    });
    expect(events[1]).toMatchObject({ type: "draft", studentId: "student-1", name: "学生甲", feedback: "", draftFeedback: "甲反馈" });
    expect(events[3]).toMatchObject({ type: "review", studentId: "student-1", feedback: "甲反馈", reviewStatus: "passed" });
    expect(events[5].students).toEqual([
      expect.objectContaining({ id: "student-1", feedback: "甲反馈", reviewStatus: "passed" }),
      expect.objectContaining({ id: "student-2", feedback: "乙反馈", reviewStatus: "passed" }),
    ]);
    expect(mocks.historyCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ module: "feedback", key: "VITEST-STREAM" }),
    }));
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: 2048,
      messages: [expect.objectContaining({
        content: expect.stringContaining("近期家校沟通"),
      })],
    }));
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        content: expect.stringContaining("#稳定"),
      })],
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
    expect(mocks.completionCreate).toHaveBeenCalledTimes(4);

    mocks.completionCreate
      .mockResolvedValueOnce({ choices: [{ message: { content: "甲新反馈" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "乙新反馈" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ verdict: "pass", feedback: "甲新反馈", issues: [] }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ verdict: "pass", feedback: "乙新反馈", issues: [] }) } }] });
    const refreshed = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionCode: "VITEST-STREAM", historyModule: "feedback", bypassCache: true }),
    }));
    const refreshedEvents = (await refreshed.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(refreshedEvents[5].students).toEqual([
      expect.objectContaining({ id: "student-1", feedback: "甲新反馈" }),
      expect.objectContaining({ id: "student-2", feedback: "乙新反馈" }),
    ]);
    expect(mocks.completionCreate).toHaveBeenCalledTimes(8);

    const saved = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "VITEST-STREAM",
        historyModule: "feedback",
        saveState: true,
        students: [
          { id: "student-1", feedback: "甲手动编辑反馈" },
          { id: "student-2", feedback: "乙手动编辑反馈" },
          { id: "unknown-student", feedback: "不应保存" },
        ],
      }),
    }));
    await expect(saved.json()).resolves.toMatchObject({
      saved: true,
      total: 2,
      students: [
        expect.objectContaining({ id: "student-1", feedback: "甲手动编辑反馈" }),
        expect.objectContaining({ id: "student-2", feedback: "乙手动编辑反馈" }),
      ],
    });
    expect(mocks.completionCreate).toHaveBeenCalledTimes(8);

    const cachedAfterSave = await POST(request());
    await expect(cachedAfterSave.json()).resolves.toMatchObject({
      cached: true,
      students: [
        expect.objectContaining({ id: "student-1", feedback: "甲手动编辑反馈" }),
        expect.objectContaining({ id: "student-2", feedback: "乙手动编辑反馈" }),
      ],
    });
  });

  it("retries empty internal analysis without exposing it as parent feedback", async () => {
    mocks.completionCreate.mockReset()
      .mockResolvedValueOnce({ choices: [{ message: { content: "" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "甲重试反馈" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ verdict: "pass", feedback: "甲重试反馈", issues: [] }) } }] });

    const response = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionCode: "VITEST-STREAM-RETRY", historyModule: "feedback", bypassCache: true }),
    }));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));

    expect(events[1]).toMatchObject({ studentId: "student-1", feedback: "", draftFeedback: "甲重试反馈" });
    expect(events[2]).toMatchObject({ studentId: "student-2", feedback: "" });
    expect(events[3]).toMatchObject({ studentId: "student-1", reviewStatus: "passed" });
    expect(events[4]).toMatchObject({ studentId: "student-2", reviewStatus: "needs_review" });
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: 2048,
    }));
  });
});
