import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  historyCreate: vi.fn(),
  completionCreate: vi.fn(),
  routing: vi.fn(),
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
  getLLMCompletionOptions: (_role: unknown, maxTokens: number) => ({ max_tokens: maxTokens }),
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

vi.mock("@/services/feedback-intensity-service", () => ({
  buildFeedbackRouting: mocks.routing,
}));

vi.mock("@/services/feedback-sections-service", () => ({
  buildFeedbackSections: vi.fn().mockReturnValue(new Map([
    ["student-1", { currentFact: { content: "学习测验 4 分", evidence: [] } }],
    ["student-2", { currentFact: { content: "学习测验无记录", evidence: [] } }],
  ])),
}));

import { POST } from "@/app/api/report/feedback-batch/route";

const lessonMaterial = {
  version: 1,
  groupFeedbackRaw: "【课堂内容】示例内容",
  assessmentBriefRaw: "考查示例概念",
  lessonTitle: "示例课程",
  classroomContent: ["示例内容"],
  classroomFocus: ["示例重点"],
  classroomExplanation: [],
  homework: [],
  assessmentFocus: ["示例概念"],
  correctionAdvice: ["订正错题"],
  otherNotes: [],
};
const assessmentEvidence = {
  "student-1": {
    reportTitle: "示例出门测",
    reportDate: "2099-06-14",
    totalQuestions: 5,
    correctRate: 80,
    cohortAverageRate: 70,
    knowledgePoints: [],
    wrongItems: [],
    similarPracticeCount: 1,
  },
};

describe("feedback batch NDJSON stream", () => {
  beforeEach(() => {
    mocks.routing.mockReset().mockResolvedValue([
      { studentId: "student-1", baseline: "priority", intensity: "priority", reasons: ["dashboard-warning"] },
      { studentId: "student-2", baseline: "priority", intensity: "priority", reasons: ["dashboard-warning"] },
    ]);
    mocks.historyCreate.mockReset().mockResolvedValue({ id: "history-1" });
    mocks.completionCreate.mockReset()
      .mockResolvedValueOnce({ choices: [{ message: { content: "甲反馈" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "乙反馈" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ verdict: "pass", feedback: "甲反馈", issues: [] }) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ verdict: "pass", feedback: "乙反馈", issues: [] }) } }] });
  });

  it("returns safe field hints when a saved feedback request is incomplete", async () => {
    const response = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "VITEST-STREAM",
        saveState: true,
        lessonMaterial: { version: 1 },
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("lessonMaterial"),
      code: "invalid_request",
    });
  });

  it("streams progress by studentId, persists final cards, and returns full cached data", async () => {
    const request = () => new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "VITEST-STREAM",
        historyModule: "feedback",
        lessonMaterial,
        assessmentEvidence,
      }),
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
    const promptContents = mocks.completionCreate.mock.calls.map((call) => call[0].messages[0].content);
    expect(promptContents.some((content) => content.includes("【本次已确认事实】学习测验 4 分"))).toBe(true);
    expect(promptContents.some((content) => content.includes("近期家校沟通"))).toBe(false);
    expect(promptContents.some((content) => content.includes("#稳定"))).toBe(false);
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        content: expect.stringContaining("示例出门测"),
      })],
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        content: expect.stringContaining("【本次生成边界】课次：VITEST-STREAM；学生ID：student-1"),
      })],
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const persistedState = JSON.parse(mocks.historyCreate.mock.calls[0][0].data.state);
    expect(persistedState.lessonMaterial.sessionCode).toBe("VITEST-STREAM");
    expect(persistedState.assessmentEvidence["student-1"]).toMatchObject({
      sessionCode: "VITEST-STREAM",
      studentId: "student-1",
    });

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

    const historyWritesBeforeMixedSave = mocks.historyCreate.mock.calls.length;
    const rejectedMixedSave = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "VITEST-STREAM",
        historyModule: "feedback",
        saveState: true,
        lessonMaterial,
        assessmentEvidence,
        students: [
          { id: "student-1", feedback: "甲手动编辑反馈" },
          { id: "student-2", feedback: "乙手动编辑反馈" },
          { id: "unknown-student", feedback: "不应保存" },
        ],
      }),
    }));
    expect(rejectedMixedSave.status).toBe(400);
    await expect(rejectedMixedSave.json()).resolves.toMatchObject({
      error: expect.stringContaining("未保存任何内容"),
      code: "invalid_request",
      retryable: false,
    });
    expect(mocks.historyCreate).toHaveBeenCalledTimes(historyWritesBeforeMixedSave);

    const saved = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "VITEST-STREAM",
        historyModule: "feedback",
        saveState: true,
        lessonMaterial,
        assessmentEvidence,
        students: [
          { id: "student-1", feedback: "甲手动编辑反馈" },
          { id: "student-2", feedback: "乙手动编辑反馈" },
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
    expect(events[2]).toMatchObject({ studentId: "student-2", reviewStatus: "needs_review" });
    expect(events[4]).toMatchObject({ type: "done" });
    expect(events[4].students).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "student-2", reviewStatus: "needs_review" }),
    ]));
    expect(mocks.completionCreate).toHaveBeenCalledWith(expect.objectContaining({
      max_tokens: 2048,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("creates teacher-only structured cards without invoking the model", async () => {
    mocks.completionCreate.mockReset();
    const response = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "VITEST-STREAM",
        historyModule: "feedback",
        bypassCache: true,
        outputStrategy: {
          flaggedIssue: true,
          trendChange: true,
          backgroundBaseline: true,
          strategySuggestion: true,
          suggestedFeedback: false,
        },
      }),
    }));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.at(-1).students[0]).toMatchObject({
      id: "student-1",
      feedback: "",
      sections: { currentFact: { content: "学习测验 4 分" } },
    });
    expect(mocks.completionCreate).not.toHaveBeenCalled();
  });

  it("stops in-flight model work and does not persist an aborted batch", async () => {
    mocks.completionCreate.mockReset().mockImplementation((
      _payload: unknown,
      options?: { signal?: AbortSignal },
    ) => new Promise((_, reject) => {
      const abort = () => reject(new DOMException("cancelled", "AbortError"));
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    }));
    const controller = new AbortController();
    const response = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "VITEST-STREAM-CANCEL",
        historyModule: "feedback",
        bypassCache: true,
      }),
      signal: controller.signal,
    }));

    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const body = response.text();
    await vi.waitFor(() => expect(mocks.completionCreate).toHaveBeenCalled());
    controller.abort();

    await expect(body).resolves.toContain("\"type\":\"init\"");
    expect(mocks.historyCreate).not.toHaveBeenCalled();
  });

  it("rejects course material or PDF evidence bound to another session or student", async () => {
    const wrongSession = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "VITEST-STREAM",
        historyModule: "feedback",
        lessonMaterial: { ...lessonMaterial, sessionCode: "OTHER-SESSION" },
      }),
    }));
    expect(wrongSession.status).toBe(400);
    await expect(wrongSession.json()).resolves.toMatchObject({
      error: expect.stringContaining("不能用于"),
    });

    const wrongStudent = await POST(new NextRequest("http://localhost:3000/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "VITEST-STREAM",
        historyModule: "feedback",
        assessmentEvidence: {
          "student-1": {
            ...assessmentEvidence["student-1"],
            sessionCode: "VITEST-STREAM",
            studentId: "student-2",
          },
        },
      }),
    }));
    expect(wrongStudent.status).toBe(400);
    await expect(wrongStudent.json()).resolves.toMatchObject({
      error: expect.stringContaining("不一致"),
    });
  });
});
