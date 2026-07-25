import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  directory: vi.fn(),
}));

vi.mock("@/services/wecom-bridge-service", () => ({
  generateWeComBridgeJson: mocks.generate,
}));
vi.mock("@/services/wecomcatch-directory-service", () => ({
  buildWccDirectorySnapshot: mocks.directory,
}));

import { acceptWccCandidateBatch } from "@/services/wecomcatch-integration-service";

describe("WCC candidate acceptance", () => {
  it("stores only a triaged summary and short evidence, not the full chat batch", async () => {
    const student = { id: "student-1", name: "张三", studentId: "S001", classId: "class-1" };
    mocks.directory.mockResolvedValue({ version: "directory-v1" });
    mocks.generate.mockResolvedValue({
      bridgeJson: {
        records: [{
          matchedStudent: { id: student.id, confidence: "high" },
          messageIds: ["message-useful"],
          factualSummary: "家长担心孩子最近觉得课程难度增加。",
          feedbackUse: { relevant: true, category: "parent-concern", priority: "high" },
          evidence: [{ messageId: "message-useful", quote: "最近觉得有点难" }],
          confidence: "high",
        }],
      },
      diagnostics: { modelName: "test-model" },
    });
    const upsert = vi.fn(async (args) => ({
      id: args.create.id,
      status: args.create.status,
      studentId: args.create.studentId,
    }));
    const prisma = {
      student: { findMany: vi.fn(async () => [student]) },
      draftRecord: { upsert },
    };

    const result = await acceptWccCandidateBatch(prisma as never, {
      contractVersion: "wcc.student-track-candidates.v1",
      batchId: "batch-1",
      directoryVersion: "directory-v1",
      source: { id: "source-1" },
      conversation: { id: "conversation-1", title: "张三妈妈" },
      messages: [
        { id: "message-useful", sentAt: "2026-07-20T08:00:00Z", content: "最近觉得有点难" },
        { id: "message-noise", sentAt: "2026-07-20T08:01:00Z", content: "收到老师，周日见" },
      ],
      subjects: [student],
      triage: {
        classifier: "semantic-feedback-triage-v2",
        reasonCodes: [
          "feedback_category_parent_concern",
          "feedback_priority_high",
        ],
        feedbackUse: {
          relevant: true,
          category: "parent-concern",
          priority: "high",
        },
      },
    });

    expect(result).toMatchObject({ status: "pending_review", drafts: [{ studentId: student.id }] });
    const create = upsert.mock.calls[0][0].create;
    const rawText = JSON.parse(create.rawText);
    expect(create.rawText).not.toContain("收到老师，周日见");
    expect(rawText).not.toHaveProperty("messages");
    expect(rawText).toMatchObject({
      messageIds: ["message-useful"],
      evidence: [{ messageId: "message-useful", quote: "最近觉得有点难" }],
      triage: {
        classifier: "semantic-feedback-triage-v2",
        feedbackUse: {
          relevant: true,
          category: "parent-concern",
          priority: "high",
        },
      },
    });
    expect(create.parsedResult).toContain("家长担心孩子最近觉得课程难度增加");
    expect(create.parsedResult).toContain("类别: parent-concern");
  });
});
