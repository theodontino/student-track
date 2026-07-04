import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  buildFeedbackContext: vi.fn(),
  completionCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/services/feedback-context-service", () => ({
  buildFeedbackContext: mocks.buildFeedbackContext,
}));

vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({ chat: { completions: { create: mocks.completionCreate } } }),
  getLLMModel: () => "test-model",
}));

import { POST } from "@/app/api/report/feedback/route";

describe("/api/report/feedback", () => {
  beforeEach(() => {
    mocks.buildFeedbackContext.mockReset().mockResolvedValue({
      session: {
        id: "session-1",
        code: "VITEST-SINGLE",
        date: "2026-06-14",
        semesterId: "semester-1",
        semesterNumber: 1,
        classId: "class-1",
      },
      className: "测试班",
      total: 1,
      students: [
        {
          id: "student-1",
          name: "学生甲",
          studentId: "S1",
          labels: ["#稳定"],
          promptContext: "学生甲上下文\n学生标签：#稳定\n近期趋势：A4/B4/C4/D5\n近期家校沟通：与母亲：希望多强调进步",
          preview: {
            today: ["学习&测验 4分"],
            trend: "A4/B4/C4/D5",
            communications: ["与母亲：希望多强调进步"],
            labels: ["#稳定"],
          },
        },
      ],
    });
    mocks.completionCreate.mockReset().mockResolvedValue({
      choices: [{ message: { content: "单人重写反馈" } }],
    });
  });

  it("uses the shared feedback context when regenerating one session feedback", async () => {
    const response = await POST(new NextRequest("http://localhost:3000/api/report/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: "student-1", sessionCode: "VITEST-SINGLE" }),
    }));

    await expect(response.json()).resolves.toEqual({ feedback: "单人重写反馈" });
    expect(mocks.buildFeedbackContext).toHaveBeenCalledWith(expect.anything(), "VITEST-SINGLE");
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: 256,
      messages: [expect.objectContaining({
        content: expect.stringContaining("学生标签：#稳定"),
      })],
    }));
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        content: expect.stringContaining("近期家校沟通"),
      })],
    }));
  });
});
