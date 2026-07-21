import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  applyWeComLedgerBatch,
  failWeComBatch,
  ignoreWeComBatchCandidate,
  prepareWeComBatch,
  pruneWeComRollbackJournal,
  retryWeComBatchCandidate,
  retryWeComBatchExtraction,
  saveWeComBatchCandidate,
} from "@/services/wecom-import-ledger-service";
import { WeComExtractionError } from "@/services/wecom-bridge-service";
import {
  listWeComRollbackOperations,
  rollbackWeComDate,
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
    const noValueMessageId = "test-wecom-message-ledger-no-value";
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
    await prisma.weComMessageReceipt.createMany({
      data: [{
        messageId,
        conversationId: "test-conversation-ledger",
        contentHash: "test-hash",
        status: "pending",
        promptVersion: "test-v1",
      }, {
        messageId: noValueMessageId,
        conversationId: "test-conversation-ledger",
        contentHash: "test-hash-no-value",
        status: "pending",
        promptVersion: "test-v1",
      }],
    });
    const metadata = {
      runId,
      batchKey,
      conversationId: "test-conversation-ledger",
      conversationTitle: "张三家长-example",
      candidateStudentIds: [student!.id],
      messageIds: [messageId, noValueMessageId],
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
      .resolves.toMatchObject({ createdCount: 1, createdLabelCount: 0 });
    await expect(prisma.weComImportOperation.findUnique({ where: { id: operation.id } }))
      .resolves.toMatchObject({ status: "complete", communicationCount: 1, labelCount: 0, candidateJson: null });
    await expect(prisma.weComMessageReceipt.findUnique({
      where: {
        conversationId_messageId: {
          conversationId: metadata.conversationId,
          messageId,
        },
      },
    }))
      .resolves.toMatchObject({ status: "imported" });
    await expect(prisma.weComMessageReceipt.findUnique({
      where: {
        conversationId_messageId: {
          conversationId: metadata.conversationId,
          messageId: noValueMessageId,
        },
      },
    })).resolves.toMatchObject({ status: "no_value" });

    const createSafetyBackup = vi.fn(async () => undefined);
    await expect(rollbackWeComRun(prisma, runId, {
      createSafetyBackup,
    })).resolves.toMatchObject({ batchCount: 1, communicationCount: 1, labelCount: 0 });
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
    await expect(prisma.weComMessageReceipt.findUnique({
      where: {
        conversationId_messageId: {
          conversationId: metadata.conversationId,
          messageId: noValueMessageId,
        },
      },
    })).resolves.toMatchObject({ status: "rolled_back" });
  });

  it("does not create automatic attention labels from企微 candidates", async () => {
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

    for (const index of [1]) {
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
    }
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

  it("pauses a stable failed segment after two attempts and only requeues it explicitly", async () => {
    const conversationId = "test-conversation-ledger-paused";
    const pausedMessageId = "test-wecom-message-ledger-paused";
    const pausedBatchKey = "test-wecom-batch-ledger-paused";
    await prisma.weComMessageReceipt.create({
      data: {
        conversationId,
        messageId: pausedMessageId,
        contentHash: "paused-hash",
        status: "pending",
        promptVersion: "test-v3",
      },
    });
    const metadataBase = {
      batchKey: pausedBatchKey,
      conversationId,
      conversationTitle: "暂停重试会话",
      candidateStudentIds: [],
      messageIds: [pausedMessageId],
      promptVersion: "test-v3",
    };

    let secondOperationId = "";
    for (const attempt of [1, 2]) {
      const currentRunId = `test-wecom-run-ledger-paused-${attempt}`;
      await prisma.weComImportRun.create({
        data: {
          id: currentRunId,
          status: "running",
          windowStartedAt: new Date("2026-07-01T00:00:00Z"),
          windowEndedAt: new Date("2026-07-20T00:00:00Z"),
        },
      });
      const operation = await prepareWeComBatch(prisma, { ...metadataBase, runId: currentRunId });
      secondOperationId = operation.id;
      await failWeComBatch(
        prisma,
        operation.id,
        conversationId,
        [pausedMessageId],
        new WeComExtractionError("schema_invalid", "synthetic schema failure", {
          modelName: "synthetic-model",
          finishReason: "stop",
          reasoningTokens: 0,
          completionTokens: 12,
          responseCharacters: 30,
        }),
      );
      await expect(prisma.weComImportOperation.findUnique({ where: { id: operation.id } }))
        .resolves.toMatchObject({
          attemptCount: attempt,
          status: attempt === 1 ? "failed" : "needs_review",
          failureCode: "schema_invalid",
          modelName: "synthetic-model",
        });
    }

    await expect(prisma.weComMessageReceipt.findUnique({
      where: { conversationId_messageId: { conversationId, messageId: pausedMessageId } },
    })).resolves.toMatchObject({ status: "needs_review" });

    await expect(retryWeComBatchExtraction(prisma, secondOperationId))
      .resolves.toEqual({ requeued: true });
    await expect(prisma.weComMessageReceipt.findUnique({
      where: { conversationId_messageId: { conversationId, messageId: pausedMessageId } },
    })).resolves.toMatchObject({ status: "pending", operationId: null });
    await expect(prisma.weComImportOperation.findUnique({ where: { id: secondOperationId } }))
      .resolves.toMatchObject({ status: "retry_requested", attemptCount: 0 });
  });

  it("rejects calendar dates that JavaScript would otherwise normalize", async () => {
    await expect(rollbackWeComDate(prisma, "2026-02-31", {
      createSafetyBackup: async () => undefined,
    })).rejects.toThrow("日期无效");
  });
});
