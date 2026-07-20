import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  applyWeComLedgerBatch,
  ignoreWeComBatchCandidate,
  prepareWeComBatch,
  pruneWeComRollbackJournal,
  retryWeComBatchCandidate,
  saveWeComBatchCandidate,
} from "@/services/wecom-import-ledger-service";
import {
  listWeComRollbackOperations,
  rollbackWeComDate,
  rollbackWeComOperation,
  rollbackWeComRun,
} from "@/services/wecom-rollback-service";

describe("wecom incremental ledger and rollback", () => {
  const messageId = "test-wecom-message-ledger-1";
  const runId = "test-wecom-run-ledger-1";
  const batchKey = "test-wecom-batch-ledger-1";
  const sourceKey = "wecomcatch:test-source-ledger-1";
  let testStudentId = "";

  afterEach(async () => {
    await prisma.weComMessageReceipt.deleteMany({
      where: { messageId: { startsWith: "test-wecom-message-ledger" } },
    });
    await prisma.weComImportOperation.deleteMany({
      where: { batchKey: { startsWith: "test-wecom-batch-ledger" } },
    });
    await prisma.weComImportRun.deleteMany({
      where: { id: { startsWith: "test-wecom-run-ledger" } },
    });
    await prisma.communication.deleteMany({
      where: { sourceKey: { startsWith: "wecomcatch:test-source-ledger" } },
    });
    if (testStudentId) await prisma.studentLabel.deleteMany({ where: { studentId: testStudentId, label: { name: "AI内部关注：家长担心" } } });
    await prisma.label.deleteMany({ where: { name: "AI内部关注：家长担心", students: { none: {} } } });
    testStudentId = "";
  });

  it("records only created rows and can roll one batch back", async () => {
    const student = await prisma.student.findFirst({
      select: { id: true, name: true, studentId: true, classId: true },
      orderBy: { studentId: "asc" },
    });
    expect(student).toBeTruthy();
    testStudentId = student!.id;
    const session = await prisma.classSession.findFirst({
      where: { classId: student!.classId },
      select: { code: true },
      orderBy: { date: "desc" },
    });
    expect(session).toBeTruthy();
    await prisma.weComImportRun.create({
      data: {
        id: runId,
        status: "running",
        windowStartedAt: new Date("2026-07-01T00:00:00Z"),
        windowEndedAt: new Date("2026-07-20T00:00:00Z"),
      },
    });
    await prisma.weComMessageReceipt.create({
      data: {
        messageId,
        conversationId: "test-conversation-ledger",
        contentHash: "test-hash",
        status: "pending",
        promptVersion: "test-v1",
      },
    });
    const metadata = {
      runId,
      batchKey,
      conversationId: "test-conversation-ledger",
      conversationTitle: "张三家长-example",
      candidateStudentIds: [student!.id],
      messageIds: [messageId],
    };
    const operation = await prepareWeComBatch(prisma, metadata);
    const jsonText = JSON.stringify({ records: [{
      kind: "communication",
      sourceKey,
      source: {
        conversationId: metadata.conversationId,
        conversationTitle: metadata.conversationTitle,
        messageIds: [messageId],
      },
      matchedStudent: { id: student!.id, name: student!.name, studentId: student!.studentId, confidence: "high" },
      sessionCode: session!.code,
      target: "家长",
      summary: "测试增量回滚沟通",
      attentionSignals: [{ reason: "parent-concern", confidence: "high", evidenceSummary: "家长明确表示担心" }],
    }] });
    await saveWeComBatchCandidate(prisma, operation.id, jsonText);

    await expect(applyWeComLedgerBatch(prisma, operation.id, metadata, jsonText))
      .resolves.toMatchObject({ createdCount: 1, createdLabelCount: 1 });
    await expect(prisma.weComImportOperation.findUnique({ where: { id: operation.id } }))
      .resolves.toMatchObject({ status: "complete", communicationCount: 1, labelCount: 1, candidateJson: null });
    await expect(prisma.weComMessageReceipt.findUnique({
      where: {
        conversationId_messageId: {
          conversationId: metadata.conversationId,
          messageId,
        },
      },
    }))
      .resolves.toMatchObject({ status: "imported" });

    const createSafetyBackup = vi.fn(async () => undefined);
    await expect(rollbackWeComRun(prisma, runId, {
      createSafetyBackup,
    })).resolves.toMatchObject({ batchCount: 1, communicationCount: 1, labelCount: 1 });
    expect(createSafetyBackup).toHaveBeenCalledOnce();
    await expect(prisma.communication.findUnique({ where: { sourceKey } })).resolves.toBeNull();
    await expect(prisma.weComMessageReceipt.findUnique({
      where: {
        conversationId_messageId: {
          conversationId: metadata.conversationId,
          messageId,
        },
      },
    }))
      .resolves.toMatchObject({ status: "rolled_back" });
  });

  it("keeps a shared label until every importing batch that supports it is rolled back", async () => {
    const student = await prisma.student.findFirst({
      select: { id: true, name: true, studentId: true, classId: true },
      orderBy: { studentId: "asc" },
    });
    expect(student).toBeTruthy();
    testStudentId = student!.id;
    const session = await prisma.classSession.findFirst({
      where: { classId: student!.classId },
      select: { code: true },
      orderBy: { date: "desc" },
    });
    expect(session).toBeTruthy();
    const sharedRunId = "test-wecom-run-ledger-shared";
    await prisma.weComImportRun.create({
      data: {
        id: sharedRunId,
        status: "complete",
        windowStartedAt: new Date("2026-07-01T00:00:00Z"),
        windowEndedAt: new Date("2026-07-20T00:00:00Z"),
      },
    });

    const operations = [];
    for (const index of [1, 2]) {
      const currentMessageId = `test-wecom-message-ledger-shared-${index}`;
      const currentBatchKey = `test-wecom-batch-ledger-shared-${index}`;
      await prisma.weComMessageReceipt.create({
        data: {
          messageId: currentMessageId,
          conversationId: `test-conversation-ledger-shared-${index}`,
          contentHash: `test-hash-${index}`,
          status: "pending",
          promptVersion: "test-v1",
        },
      });
      const metadata = {
        runId: sharedRunId,
        batchKey: currentBatchKey,
        conversationId: `test-conversation-ledger-shared-${index}`,
        conversationTitle: `共享标签会话 ${index}`,
        candidateStudentIds: [student!.id],
        messageIds: [currentMessageId],
      };
      const operation = await prepareWeComBatch(prisma, metadata);
      const jsonText = JSON.stringify({ records: [{
        kind: "communication",
        sourceKey: `wecomcatch:test-source-ledger-shared-${index}`,
        source: {
          conversationId: metadata.conversationId,
          conversationTitle: metadata.conversationTitle,
          messageIds: [currentMessageId],
        },
        matchedStudent: {
          id: student!.id,
          name: student!.name,
          studentId: student!.studentId,
          confidence: "high",
        },
        sessionCode: session!.code,
        target: "家长",
        summary: `共享标签沟通 ${index}`,
        attentionSignals: [{
          reason: "parent-concern",
          confidence: "high",
          evidenceSummary: "家长明确表示担心",
        }],
      }] });
      await saveWeComBatchCandidate(prisma, operation.id, jsonText);
      await applyWeComLedgerBatch(prisma, operation.id, metadata, jsonText);
      operations.push(operation);
    }

    await rollbackWeComOperation(prisma, operations[0].id, {
      createSafetyBackup: async () => undefined,
    });
    await expect(prisma.studentLabel.findFirst({
      where: {
        studentId: student!.id,
        label: { name: "AI内部关注：家长担心" },
      },
    })).resolves.toBeTruthy();

    await rollbackWeComOperation(prisma, operations[1].id, {
      createSafetyBackup: async () => undefined,
    });
    await expect(prisma.studentLabel.findFirst({
      where: {
        studentId: student!.id,
        label: { name: "AI内部关注：家长担心" },
      },
    })).resolves.toBeNull();
  });

  it("can retry or ignore unwritten batches and reports them in the maintenance list", async () => {
    const student = await prisma.student.findFirst({
      select: { id: true, name: true, studentId: true, classId: true },
      orderBy: { studentId: "asc" },
    });
    expect(student).toBeTruthy();
    testStudentId = student!.id;
    const session = await prisma.classSession.findFirst({
      where: { classId: student!.classId },
      select: { code: true },
      orderBy: { date: "desc" },
    });
    expect(session).toBeTruthy();
    const reviewRunId = "test-wecom-run-ledger-review";
    await prisma.weComImportRun.create({
      data: {
        id: reviewRunId,
        status: "attention_required",
        windowStartedAt: new Date("2026-07-01T00:00:00Z"),
        windowEndedAt: new Date("2026-07-20T00:00:00Z"),
        completedAt: new Date(),
      },
    });

    const retryMessageId = "test-wecom-message-ledger-retry";
    const retryConversationId = "test-conversation-ledger-retry";
    const retryJson = JSON.stringify({ records: [{
      kind: "communication",
      sourceKey: "wecomcatch:test-source-ledger-retry",
      source: {
        conversationId: retryConversationId,
        conversationTitle: "重试候选",
        messageIds: [retryMessageId],
      },
      matchedStudent: {
        id: student!.id,
        name: student!.name,
        studentId: student!.studentId,
        confidence: "high",
      },
      sessionCode: session!.code,
      target: "家长",
      summary: "重试后写入",
    }] });
    const retryOperation = await prisma.weComImportOperation.create({
      data: {
        runId: reviewRunId,
        batchKey: "test-wecom-batch-ledger-retry",
        conversationId: retryConversationId,
        conversationTitle: "重试候选",
        status: "needs_review",
        messageCount: 1,
        candidateStudentIds: JSON.stringify([student!.id]),
        candidateJson: retryJson,
        completedAt: new Date(),
      },
    });
    await prisma.weComMessageReceipt.create({
      data: {
        conversationId: retryConversationId,
        messageId: retryMessageId,
        contentHash: "retry-hash",
        status: "needs_review",
        promptVersion: "test",
        operationId: retryOperation.id,
      },
    });
    await expect(retryWeComBatchCandidate(prisma, retryOperation.id))
      .resolves.toMatchObject({ createdCount: 1 });

    const ignoredOperation = await prisma.weComImportOperation.create({
      data: {
        runId: reviewRunId,
        batchKey: "test-wecom-batch-ledger-ignore",
        conversationId: "test-conversation-ledger-ignore",
        conversationTitle: "忽略候选",
        status: "failed",
        messageCount: 1,
        candidateStudentIds: JSON.stringify([student!.id]),
        candidateJson: JSON.stringify({ records: [] }),
        completedAt: new Date(),
      },
    });
    await prisma.weComMessageReceipt.create({
      data: {
        conversationId: "test-conversation-ledger-ignore",
        messageId: "test-wecom-message-ledger-ignore",
        contentHash: "ignore-hash",
        status: "failed",
        promptVersion: "test",
        operationId: ignoredOperation.id,
      },
    });

    await expect(ignoreWeComBatchCandidate(prisma, ignoredOperation.id))
      .resolves.toEqual({ ignored: true });
    await expect(listWeComRollbackOperations(prisma)).resolves.toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({ id: reviewRunId }),
      ]),
      retention: { days: 30, runs: 30, safetyBackups: 3 },
    });
    await expect(pruneWeComRollbackJournal(prisma)).resolves.toBeUndefined();
  });

  it("rejects calendar dates that JavaScript would otherwise normalize", async () => {
    await expect(rollbackWeComDate(prisma, "2026-02-31", {
      createSafetyBackup: async () => undefined,
    })).rejects.toThrow("日期无效");
  });
});
