import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    mocks.generate.mockReset();
    mocks.directory.mockReset();
  });

  it("stores only a triaged summary and short evidence, not the full chat batch", async () => {
    const student = { id: "student-1", name: "张三", studentId: "S001", classId: "class-1" };
    mocks.directory.mockResolvedValue({ version: "directory-current" });
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
        // 让 student-1 所在班级在 2026-07-20 那天有课
        findMany: vi.fn(async () => [{ code: "2026072001", classId: "class-1", date: "2026-07-20" }]),
      },
      systemLog: { create: vi.fn() },
      draftRecord: { upsert },
    };

    const result = await acceptWccCandidateBatch(prisma as never, {
      contractVersion: "wcc.student-track-candidates.v1",
      batchId: "batch-1",
      directoryVersion: "directory-from-wcc-sqlite",
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

    expect(result).toMatchObject({
      status: "pending_review",
      drafts: [{ studentId: student.id }],
      directoryRevalidated: true,
      receivedDirectoryVersion: "directory-from-wcc-sqlite",
      currentDirectoryVersion: "directory-current",
    });
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
    // 同一中国日历日且当天唯一一节课时，课次由应用层确定性绑定，无需 LLM 参与。
    expect(create.sessionCode).toBe("2026072001");
    const wccSource = JSON.parse(create.parsedResult).wccSource;
    expect(wccSource.occurredAt).toEqual({ min: "2026-07-20", max: "2026-07-20" });
  });

  it("rejects a stale subject only when its stable identity actually changed", async () => {
    mocks.directory.mockResolvedValue({ version: "directory-current" });
    const prisma = {
      student: {
        findMany: vi.fn(async () => [{
          id: "student-1",
          name: "李四",
          studentId: "S001",
          classId: "class-2",
        }]),
      },
      draftRecord: { upsert: vi.fn() },
    };
    await expect(acceptWccCandidateBatch(prisma as never, {
      contractVersion: "wcc.student-track-candidates.v1",
      batchId: "batch-conflict",
      directoryVersion: "directory-old",
      source: { id: "source-1" },
      conversation: { id: "conversation-1", title: "测试会话" },
      messages: [{ id: "message-1", content: "固定合成消息" }],
      subjects: [{ id: "student-1", name: "张三", studentId: "S001", classId: "class-1" }],
    })).rejects.toThrow("directory_conflict");
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("allows a class transfer when id, name, and student number remain stable", async () => {
    mocks.directory.mockResolvedValue({ version: "directory-current" });
    mocks.generate.mockResolvedValue({
      bridgeJson: { records: [] },
      diagnostics: { modelName: "test-model" },
    });
    const prisma = {
      student: {
        findMany: vi.fn(async () => [{
          id: "student-1",
          name: "张三",
          studentId: "S001",
          classId: "class-new",
        }]),
      },
      // 该 batch 的消息没有 sentAt，minDate/maxDate 均为 null，
      // 走"无任何候选"路径，预期写系统日志并返回 no_value。
      classSession: { findMany: vi.fn(async () => []) },
      systemLog: { create: vi.fn() },
      draftRecord: { upsert: vi.fn() },
    };
    await expect(acceptWccCandidateBatch(prisma as never, {
      contractVersion: "wcc.student-track-candidates.v1",
      batchId: "batch-transfer",
      directoryVersion: "directory-old",
      source: { id: "source-1" },
      conversation: { id: "conversation-1", title: "测试会话" },
      messages: [{ id: "message-1", content: "固定合成消息" }],
      subjects: [{ id: "student-1", name: "张三", studentId: "S001", classId: "class-old" }],
    })).resolves.toMatchObject({
      status: "no_value",
      directoryRevalidated: true,
    });
  });

  it("leaves cross-day evidence unbound for teacher selection", async () => {
    const student = { id: "student-1", name: "张三", studentId: "S001", classId: "class-1" };
    mocks.directory.mockResolvedValue({ version: "directory-current" });
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
    const upsert = vi.fn(async (args) => ({ id: args.create.id, status: args.create.status, studentId: args.create.studentId }));
    const prisma = {
      student: { findMany: vi.fn(async () => [student]) },
      classSession: { findMany: vi.fn(async () => [{ code: "2026072001" }]) },
      draftRecord: { upsert },
    };

    await acceptWccCandidateBatch(prisma as never, {
      contractVersion: "wcc.student-track-candidates.v1",
      batchId: "batch-cross-day",
      directoryVersion: "directory-current",
      source: { id: "source-1" },
      conversation: { id: "conversation-1", title: "测试会话" },
      messages: [
        { id: "message-1", sentAt: "2026-07-20T20:00:00+08:00", content: "第一天" },
        { id: "message-2", sentAt: "2026-07-21T09:00:00+08:00", content: "第二天" },
      ],
      subjects: [student],
    });

    expect(upsert.mock.calls[0][0].create.sessionCode).toBeNull();
    // 课次会按整批日期预取；跨日证据本身仍不得自动绑定。
    expect(prisma.classSession.findMany).toHaveBeenCalledTimes(1);
  });

  it("does not auto-bind a transferred student using the current class", async () => {
    const currentStudent = { id: "student-1", name: "张三", studentId: "S001", classId: "class-new" };
    mocks.directory.mockResolvedValue({ version: "directory-current" });
    mocks.generate.mockResolvedValue({
      bridgeJson: {
        records: [{
          matchedStudent: { id: currentStudent.id, confidence: "high" },
          messageIds: ["message-1"],
          factualSummary: "家长提到之前的学习安排。",
          feedbackUse: { relevant: true, category: "learning-method", priority: "medium" },
          evidence: [],
        }],
      },
      diagnostics: { modelName: "test-model" },
    });
    const upsert = vi.fn(async (args) => ({ id: args.create.id, status: args.create.status, studentId: args.create.studentId }));
    const prisma = {
      student: { findMany: vi.fn(async () => [currentStudent]) },
      classSession: { findMany: vi.fn(async () => [{ code: "2026072001" }]) },
      draftRecord: { upsert },
    };

    await acceptWccCandidateBatch(prisma as never, {
      contractVersion: "wcc.student-track-candidates.v1",
      batchId: "batch-transferred-evidence",
      directoryVersion: "directory-old",
      source: { id: "source-1" },
      conversation: { id: "conversation-1", title: "测试会话" },
      messages: [{ id: "message-1", sentAt: "2026-07-20T08:00:00+08:00", content: "测试消息" }],
      subjects: [{ ...currentStudent, classId: "class-old" }],
    });

    expect(upsert.mock.calls[0][0].create.sessionCode).toBeNull();
    // 课次会按整批日期预取；转班学生仍不得自动绑定。
    expect(prisma.classSession.findMany).toHaveBeenCalledTimes(1);
  });

  it("keeps a useful candidate pending when no exact course can be determined", async () => {
    const student = { id: "student-1", name: "张三", studentId: "S001", classId: "class-orphan" };
    mocks.directory.mockResolvedValue({ version: "directory-current" });
    mocks.generate.mockResolvedValue({
      bridgeJson: {
        records: [{
          matchedStudent: { id: student.id, confidence: "high" },
          messageIds: ["message-1"],
          factualSummary: "家长提到近期学习状态。",
          feedbackUse: { relevant: true, category: "learning-method", priority: "medium" },
          evidence: [],
        }],
      },
      diagnostics: { modelName: "test-model" },
    });
    const upsert = vi.fn(async (args) => ({ id: args.create.id, status: args.create.status, studentId: args.create.studentId }));
    const prisma = {
      student: { findMany: vi.fn(async () => [student]) },
      // class-orphan 在 2026-07-20 没有任何课次记录。
      classSession: { findMany: vi.fn(async () => []) },
      draftRecord: { upsert },
    };
    const result = await acceptWccCandidateBatch(prisma as never, {
      contractVersion: "wcc.student-track-candidates.v1",
      batchId: "batch-orphan-class",
      directoryVersion: "directory-current",
      source: { id: "source-1" },
      conversation: { id: "conversation-1", title: "孤儿班级会话" },
      messages: [{ id: "message-1", sentAt: "2026-07-20T08:00:00Z", content: "测试消息" }],
      subjects: [student],
    });
    expect(result).toMatchObject({ status: "pending_review", drafts: [{ studentId: student.id }] });
    expect(upsert.mock.calls[0][0].create.sessionCode).toBeNull();
  });

  it("does not auto-bind when the same class has multiple sessions on the evidence date", async () => {
    const student = { id: "student-1", name: "张三", studentId: "S001", classId: "class-1" };
    mocks.directory.mockResolvedValue({ version: "directory-current" });
    mocks.generate.mockResolvedValue({
      bridgeJson: {
        records: [{
          matchedStudent: { id: student.id, confidence: "high" },
          messageIds: ["m-1"],
          factualSummary: "学生反馈课程难度。",
          feedbackUse: { relevant: true, category: "learning-difficulty", priority: "high" },
          evidence: [{ messageId: "m-1", quote: "今天课有点难" }],
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
      // 同班同日两节课，不能任意挑其中一节。
      classSession: {
        findMany: vi.fn(async () => [
          { code: "2026071901" },
          { code: "2026071902" },
        ]),
      },
      systemLog: { create: vi.fn() },
      draftRecord: { upsert },
    };
    await acceptWccCandidateBatch(prisma as never, {
      contractVersion: "wcc.student-track-candidates.v1",
      batchId: "batch-multi",
      directoryVersion: "directory-current",
      source: { id: "source-1" },
      conversation: { id: "conversation-1", title: "多节课测试" },
      messages: [
        { id: "m-1", sentAt: "2026-07-19T08:00:00Z", content: "今天课有点难" },
        { id: "m-2", sentAt: "2026-07-20T08:00:00Z", content: "与该候选无关的后续消息" },
      ],
      subjects: [student],
    });
    const create = upsert.mock.calls[0][0].create;
    expect(create.sessionCode).toBeNull();
  });
});
