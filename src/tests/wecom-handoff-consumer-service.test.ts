import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WccStudentTrackFileV1 } from "@/lib/contracts/wecom-file-transfer";

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock("@/services/wecom-handoff-extraction-service", () => ({
  generateWeComBridgeJson: mocks.generate,
}));

import { consumeWccHandoffPackage } from "@/services/wecom-handoff-consumer-service";

function payload(messages: WccStudentTrackFileV1["messages"]): WccStudentTrackFileV1 {
  return {
    contractVersion: "wcc.student-track-file.v1",
    packageId: "package-1",
    producedAt: "2026-07-20T08:10:00Z",
    producer: { name: "wecomcatch", version: "0.3.1" },
    source: { id: "source-1", watermark: 2 },
    conversation: { id: "conversation-1", title: "张三妈妈" },
    timeRange: {
      start: messages[0]?.sentAt || null,
      end: messages.at(-1)?.sentAt || null,
      timezone: "Asia/Shanghai",
    },
    completeness: { archiveStatus: "complete", sourceMessageCount: messages.length },
    classification: {
      worthProcessing: true,
      decision: "high_value",
      reasons: ["parent_concern"],
      classifier: "semantic-feedback-triage-v2",
    },
    messages,
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
  };
}

describe("WCC handoff consumer", () => {
  beforeEach(() => mocks.generate.mockReset());

  it("creates an evidence-grounded draft directly from handoff v1", async () => {
    const student = { id: "student-1", name: "张三", studentId: "S001", classId: "class-1" };
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
      classSession: {
        findMany: vi.fn(async () => [
          { code: "2026072001", classId: "class-1", date: "2026-07-20" },
        ]),
      },
      draftRecord: { upsert },
    };

    const result = await consumeWccHandoffPackage(prisma as never, payload([
      { id: "message-useful", sentAt: "2026-07-20T08:00:00Z", content: "最近觉得有点难" },
      { id: "message-noise", sentAt: "2026-07-20T08:01:00Z", content: "收到老师，周日见" },
    ]), student.id);

    expect(result).toMatchObject({
      packageId: "package-1",
      status: "pending_review",
      drafts: [{ studentId: student.id }],
    });
    const create = upsert.mock.calls[0][0].create;
    expect(create.rawText).not.toContain("收到老师，周日见");
    expect(JSON.parse(create.rawText)).toMatchObject({
      packageId: "package-1",
      messageIds: ["message-useful"],
      classification: { classifier: "semantic-feedback-triage-v2" },
    });
    expect(create.sessionCode).toBe("2026072001");
  });

  it("leaves cross-day evidence unbound for teacher selection", async () => {
    const student = { id: "student-1", name: "张三", studentId: "S001", classId: "class-1" };
    mocks.generate.mockResolvedValue({
      bridgeJson: {
        records: [{
          matchedStudent: { id: student.id, confidence: "high" },
          messageIds: ["message-1", "message-2"],
          factualSummary: "家长补充了近期学习状态。",
          feedbackUse: { relevant: true, category: "learning-confidence", priority: "medium" },
          evidence: [],
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
      classSession: { findMany: vi.fn(async () => []) },
      draftRecord: { upsert },
    };

    await consumeWccHandoffPackage(prisma as never, payload([
      { id: "message-1", sentAt: "2026-07-20T20:00:00+08:00", content: "第一天" },
      { id: "message-2", sentAt: "2026-07-21T09:00:00+08:00", content: "第二天" },
    ]), student.id);

    expect(upsert.mock.calls[0][0].create.sessionCode).toBeNull();
  });

  it("rejects a selected student that no longer exists", async () => {
    const prisma = { student: { findMany: vi.fn(async () => []) } };
    await expect(consumeWccHandoffPackage(prisma as never, payload([
      { id: "message-1", content: "固定合成消息" },
    ]), "student-missing")).rejects.toThrow("directory_conflict");
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
