import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  buildFeedbackContext: vi.fn(),
  completionCreate: vi.fn(),
  routing: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/services/feedback-context-service", () => ({
  buildFeedbackContext: mocks.buildFeedbackContext,
}));

vi.mock("@/services/feedback-intensity-service", () => ({
  buildFeedbackRouting: mocks.routing,
}));

vi.mock("@/services/feedback-sections-service", () => ({
  buildFeedbackSections: vi.fn().mockReturnValue(new Map([
    ["student-1", { currentFact: { content: "学习测验 4 分", evidence: [] } }],
  ])),
}));

vi.mock("@/services/generation-memory-service", () => ({
  recordSuccessfulGeneration: vi.fn().mockResolvedValue(undefined),
  compactHotGenerationRecordsForClass: vi.fn().mockResolvedValue({ compacted: 0, runId: null }),
}));

vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({ chat: { completions: { create: mocks.completionCreate } } }),
  getLLMModel: () => "test-model",
  getLLMCompletionOptions: (_role: unknown, maxTokens: number) => ({ max_tokens: maxTokens }),
}));

import { POST } from "@/app/api/report/feedback/route";

const singleFeedback = "单".repeat(90);
const retryFeedback = "重".repeat(90);

describe("/api/report/feedback", () => {
  beforeEach(() => {
    mocks.routing.mockReset().mockResolvedValue([
      { studentId: "student-1", baseline: "priority", intensity: "priority", reasons: ["dashboard-warning"] },
    ]);
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
      choices: [{ message: { content: singleFeedback } }],
    }).mockResolvedValueOnce({
      choices: [{ message: { content: singleFeedback } }],
    }).mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ verdict: "pass", feedback: singleFeedback, issues: [] }) } }],
    });
  });

  it("uses the shared feedback context when regenerating one session feedback", async () => {
    const response = await POST(new NextRequest("http://localhost:3000/api/report/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: "student-1", sessionCode: "VITEST-SINGLE" }),
    }));

    await expect(response.json()).resolves.toMatchObject({
      draftFeedback: singleFeedback,
      feedback: singleFeedback,
      reviewStatus: "passed",
      reviewIssues: [],
    });
    expect(mocks.buildFeedbackContext).toHaveBeenCalledWith(expect.anything(), "VITEST-SINGLE");
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: 2048,
      messages: [expect.objectContaining({ content: expect.stringContaining("【本次已确认事实】学习测验 4 分") })],
    }));
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        content: expect.stringContaining("【本次生成边界】课次:VITEST-SINGLE;学生ID:student-1"),
      })],
    }));
  });

  it("retries once when the LLM returns empty content", async () => {
    mocks.completionCreate.mockReset()
      .mockResolvedValueOnce({ choices: [{ message: { content: "" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: retryFeedback } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ verdict: "pass", feedback: retryFeedback, issues: [] }) } }] });

    const response = await POST(new NextRequest("http://localhost:3000/api/report/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId: "student-1", sessionCode: "VITEST-SINGLE" }),
    }));

    await expect(response.json()).resolves.toMatchObject({ feedback: retryFeedback, reviewStatus: "passed" });
    expect(mocks.completionCreate).toHaveBeenCalledTimes(3);
  });

  it("rejects one-student evidence bound to another session", async () => {
    const response = await POST(new NextRequest("http://localhost:3000/api/report/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studentId: "student-1",
        sessionCode: "VITEST-SINGLE",
        assessmentEvidence: {
          sessionCode: "OTHER-SESSION",
          studentId: "student-1",
          reportTitle: "测试报告",
          reportDate: "2099-01-01",
          totalQuestions: 1,
          correctRate: 100,
          cohortAverageRate: null,
          knowledgePoints: [],
          wrongItems: [],
          similarPracticeCount: 0,
        },
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("课次不一致"),
    });
    expect(mocks.buildFeedbackContext).not.toHaveBeenCalled();
  });
});
