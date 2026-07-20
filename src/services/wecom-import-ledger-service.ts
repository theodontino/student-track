import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { INTERNAL_ATTENTION_LABELS, type AttentionSignalCandidate } from "@/lib/attention-labels";
import { planWeComCommunicationImport, type WeComImportResult } from "@/services/wecom-import-service";
import type { WeComExtractionDiagnostics, WeComExtractionErrorCode } from "@/services/wecom-bridge-service";

const ROLLBACK_RETENTION_DAYS = 30;
const ROLLBACK_RETENTION_OPERATIONS = 30;

export interface WeComBatchMetadata {
  runId: string;
  batchKey: string;
  conversationId: string;
  conversationTitle: string;
  candidateStudentIds: string[];
  messageIds: string[];
  promptVersion?: string;
}

export async function prepareWeComBatch(
  prisma: PrismaClient,
  metadata: WeComBatchMetadata,
) {
  const retryRequested = await prisma.weComImportOperation.findFirst({
    where: { batchKey: metadata.batchKey, status: "retry_requested" },
    orderBy: { startedAt: "desc" },
    select: { id: true, status: true, candidateJson: true, extractedAt: true, attemptCount: true },
  });
  const previousOperation = retryRequested ?? await prisma.weComImportOperation.findFirst({
    where: {
      batchKey: metadata.batchKey,
      status: { in: ["failed", "needs_review"] },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, status: true, candidateJson: true, extractedAt: true, attemptCount: true },
  });
  const attemptCount = (previousOperation?.attemptCount ?? 0) + 1;
  const operation = await prisma.weComImportOperation.upsert({
    where: {
      runId_batchKey: {
        runId: metadata.runId,
        batchKey: metadata.batchKey,
      },
    },
    create: {
      runId: metadata.runId,
      batchKey: metadata.batchKey,
      conversationId: metadata.conversationId,
      conversationTitle: metadata.conversationTitle,
      status: "processing",
      messageCount: metadata.messageIds.length,
      candidateStudentIds: JSON.stringify(metadata.candidateStudentIds),
      candidateJson: previousOperation?.candidateJson,
      extractedAt: previousOperation?.extractedAt,
      attemptCount,
      promptVersion: metadata.promptVersion,
    },
    update: {
      status: "processing",
      messageCount: metadata.messageIds.length,
      candidateStudentIds: JSON.stringify(metadata.candidateStudentIds),
      rolledBackAt: null,
      attemptCount,
      promptVersion: metadata.promptVersion,
      failureCode: null,
      completedAt: null,
    },
  });
  await prisma.weComMessageReceipt.updateMany({
    where: {
      conversationId: metadata.conversationId,
      messageId: { in: metadata.messageIds },
    },
    data: { status: "extracting", operationId: operation.id, lastError: null },
  });
  if (previousOperation?.candidateJson && previousOperation.id !== operation.id) {
    await prisma.weComImportOperation.update({
      where: { id: previousOperation.id },
      data: { candidateJson: null },
    });
  }
  if (retryRequested && retryRequested.id !== operation.id) {
    await prisma.weComImportOperation.update({
      where: { id: retryRequested.id },
      data: { status: "retry_consumed" },
    });
  }
  return operation;
}

export async function saveWeComBatchDiagnostics(
  prisma: PrismaClient,
  operationId: string,
  diagnostics: WeComExtractionDiagnostics,
) {
  await prisma.weComImportOperation.update({
    where: { id: operationId },
    data: {
      modelName: diagnostics.modelName,
      finishReason: diagnostics.finishReason,
      promptTokens: diagnostics.promptTokens,
      reasoningTokens: diagnostics.reasoningTokens,
      completionTokens: diagnostics.completionTokens,
      responseCharacters: diagnostics.responseCharacters,
    },
  });
}

function extractionFailure(error: unknown): {
  code: WeComExtractionErrorCode | "batch_failed";
  message: string;
  diagnostics?: Partial<WeComExtractionDiagnostics>;
} {
  const candidate = error as {
    code?: WeComExtractionErrorCode;
    diagnostics?: Partial<WeComExtractionDiagnostics>;
  };
  switch (candidate?.code) {
    case "protocol_incompatible":
      return { code: candidate.code, message: "提取模型不支持结构化输出，请更换模型", diagnostics: candidate.diagnostics };
    case "output_truncated":
      return { code: candidate.code, message: "模型输出被截断，需要缩小会话段或人工复核", diagnostics: candidate.diagnostics };
    case "schema_invalid":
      return { code: candidate.code, message: "模型输出未通过 Schema 校验", diagnostics: candidate.diagnostics };
    case "network_error":
      return { code: candidate.code, message: "模型网络请求连续失败", diagnostics: candidate.diagnostics };
    case "provider_error":
      return { code: candidate.code, message: "模型服务拒绝或异常结束", diagnostics: candidate.diagnostics };
    case "oversized_message":
      return { code: candidate.code, message: "单条消息超过 20000 字符，需要人工复核", diagnostics: candidate.diagnostics };
    default:
      return { code: "batch_failed", message: "批次处理失败，可安全重试" };
  }
}

export async function saveWeComBatchCandidate(
  prisma: PrismaClient,
  operationId: string,
  candidateJson: string,
) {
  await prisma.weComImportOperation.update({
    where: { id: operationId },
    data: { candidateJson, extractedAt: new Date() },
  });
}

export async function failWeComBatch(
  prisma: PrismaClient,
  operationId: string,
  conversationId: string,
  messageIds: string[],
  error: unknown,
  options: { forceReview?: boolean } = {},
) {
  const failure = extractionFailure(error);
  const current = await prisma.weComImportOperation.findUnique({
    where: { id: operationId },
    select: { attemptCount: true },
  });
  const needsReview = options.forceReview
    || current?.attemptCount && current.attemptCount >= 2
    || ["protocol_incompatible", "oversized_message"].includes(failure.code);
  const status = needsReview ? "needs_review" : "failed";
  const diagnostics = failure.diagnostics;
  await prisma.$transaction([
    prisma.weComImportOperation.update({
      where: { id: operationId },
      data: {
        status,
        failureCode: failure.code,
        modelName: diagnostics?.modelName,
        finishReason: diagnostics?.finishReason,
        promptTokens: diagnostics?.promptTokens,
        reasoningTokens: diagnostics?.reasoningTokens,
        completionTokens: diagnostics?.completionTokens,
        responseCharacters: diagnostics?.responseCharacters,
        completedAt: new Date(),
      },
    }),
    prisma.weComMessageReceipt.updateMany({
      where: { conversationId, messageId: { in: messageIds } },
      data: { status, lastError: failure.message },
    }),
  ]);
  return { status, failureCode: failure.code, message: failure.message };
}

export async function markWeComBatchSplit(
  prisma: PrismaClient,
  operationId: string,
  error: unknown,
) {
  const failure = extractionFailure(error);
  await prisma.weComImportOperation.update({
    where: { id: operationId },
    data: {
      status: "split",
      failureCode: failure.code,
      modelName: failure.diagnostics?.modelName,
      finishReason: failure.diagnostics?.finishReason,
      promptTokens: failure.diagnostics?.promptTokens,
      reasoningTokens: failure.diagnostics?.reasoningTokens,
      completionTokens: failure.diagnostics?.completionTokens,
      responseCharacters: failure.diagnostics?.responseCharacters,
      completedAt: new Date(),
    },
  });
}

async function addLabelsWithJournal(
  tx: Prisma.TransactionClient,
  operationId: string,
  studentId: string,
  candidates: AttentionSignalCandidate[],
) {
  const names = [...new Set(candidates
    .filter((candidate) => candidate.confidence === "high")
    .map((candidate) => INTERNAL_ATTENTION_LABELS[candidate.reason]))];
  let createdCount = 0;
  for (const name of names) {
    const label = await tx.label.upsert({ where: { name }, create: { name }, update: {} });
    const existing = await tx.studentLabel.findUnique({ where: { studentId_labelId: { studentId, labelId: label.id } } });
    const entityId = `${studentId}:${label.id}`;
    if (!existing) {
      await tx.studentLabel.create({ data: { studentId, labelId: label.id } });
      await tx.weComImportChange.create({
        data: {
          operationId,
          entityType: "student_label_created",
          entityId,
          studentId,
          labelId: label.id,
        },
      });
      createdCount += 1;
    }
    await tx.weComImportChange.upsert({
      where: {
        operationId_entityType_entityId: {
          operationId,
          entityType: "student_label_claim",
          entityId,
        },
      },
      create: {
        operationId,
        entityType: "student_label_claim",
        entityId,
        studentId,
        labelId: label.id,
      },
      update: {},
    });
  }
  return createdCount;
}

export async function applyWeComLedgerBatch(
  prisma: PrismaClient,
  operationId: string,
  metadata: WeComBatchMetadata,
  jsonText: string,
): Promise<WeComImportResult> {
  const planned = await planWeComCommunicationImport(prisma, {
    jsonText,
    allowedStudentIds: metadata.candidateStudentIds,
    allowedMessageIds: metadata.messageIds,
    expectedConversationId: metadata.conversationId,
    requireMessageIds: true,
    useOccurredAtSession: true,
  });
  const createPlans = planned.plans.filter((plan) => !plan.duplicate);
  let createdLabelCount = 0;

  if (planned.skippedCount > 0) {
    const uncertainSource = planned.skipped.some((item) => item.messageIds.length === 0);
    const reviewIds = uncertainSource
      ? metadata.messageIds
      : [...new Set([
        ...planned.plans.flatMap((plan) => plan.source.messageIds),
        ...planned.skipped.flatMap((item) => item.messageIds),
      ])];
    const noValueIds = metadata.messageIds.filter((messageId) => !reviewIds.includes(messageId));
    await prisma.$transaction(async (tx) => {
      if (reviewIds.length > 0) {
        await tx.weComMessageReceipt.updateMany({
          where: {
            conversationId: metadata.conversationId,
            messageId: { in: reviewIds },
          },
          data: { status: "needs_review", processedAt: new Date(), lastError: null },
        });
      }
      if (noValueIds.length > 0) {
        await tx.weComMessageReceipt.updateMany({
          where: {
            conversationId: metadata.conversationId,
            messageId: { in: noValueIds },
          },
          data: { status: "no_value", processedAt: new Date(), lastError: null },
        });
      }
      await tx.weComImportOperation.update({
        where: { id: operationId },
        data: {
          status: "needs_review",
          communicationCount: 0,
          labelCount: 0,
          completedAt: new Date(),
        },
      });
    });
    return {
      ...planned,
      mode: "apply",
      createdCount: 0,
      createdLabelCount: 0,
    };
  }

  await prisma.$transaction(async (tx) => {
    for (const plan of createPlans) {
      const communication = await tx.communication.create({
        data: {
          studentId: plan.student.id,
          sessionId: plan.session.id,
          target: plan.target,
          summary: plan.summary,
          sourceKey: plan.sourceKey || null,
        },
      });
      await tx.weComImportChange.create({
        data: { operationId, entityType: "communication", entityId: communication.id },
      });
      createdLabelCount += await addLabelsWithJournal(
        tx,
        operationId,
        plan.student.id,
        plan.attentionSignals,
      );
    }

    const importedIds = [...new Set(planned.plans.flatMap((plan) => plan.source.messageIds))];
    const noValueIds = metadata.messageIds.filter((messageId) => !importedIds.includes(messageId));
    if (importedIds.length > 0) {
      await tx.weComMessageReceipt.updateMany({
        where: {
          conversationId: metadata.conversationId,
          messageId: { in: importedIds },
        },
        data: { status: "imported", processedAt: new Date(), lastError: null },
      });
    }
    if (noValueIds.length > 0) {
      await tx.weComMessageReceipt.updateMany({
        where: {
          conversationId: metadata.conversationId,
          messageId: { in: noValueIds },
        },
        data: { status: "no_value", processedAt: new Date(), lastError: null },
      });
    }
    await tx.weComImportOperation.update({
      where: { id: operationId },
      data: {
        status: "complete",
        communicationCount: createPlans.length,
        labelCount: createdLabelCount,
        completedAt: new Date(),
        candidateJson: null,
      },
    });
  });

  return {
    ...planned,
    mode: "apply",
    createdCount: createPlans.length,
    createdLabelCount,
    plans: planned.plans.map((plan) => ({ ...plan, duplicate: plan.duplicate || !createPlans.includes(plan) })),
  };
}

async function refreshRunSummary(prisma: PrismaClient, runId: string) {
  const operations = await prisma.weComImportOperation.findMany({
    where: { runId },
    select: {
      status: true,
      communicationCount: true,
      labelCount: true,
    },
  });
  const hasAttention = operations.some((operation) => (
    operation.status === "needs_review" || operation.status === "failed"
  ));
  await prisma.weComImportRun.update({
    where: { id: runId },
    data: {
      status: hasAttention ? "attention_required" : "complete",
      communicationCount: operations.reduce(
        (sum, operation) => sum + operation.communicationCount,
        0,
      ),
      labelCount: operations.reduce((sum, operation) => sum + operation.labelCount, 0),
    },
  });
}

export async function retryWeComBatchCandidate(
  prisma: PrismaClient,
  operationId: string,
) {
  const operation = await prisma.weComImportOperation.findFirst({
    where: { id: operationId, status: { in: ["needs_review", "failed"] } },
    include: {
      receipts: {
        select: { messageId: true },
      },
    },
  });
  if (!operation?.candidateJson) {
    throw new Error("这个批次没有可重试的候选内容，请重新执行一键导入");
  }
  let candidateStudentIds: string[] = [];
  try {
    const parsed = JSON.parse(operation.candidateStudentIds) as unknown;
    if (Array.isArray(parsed)) {
      candidateStudentIds = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    throw new Error("候选学生范围已损坏，请重新执行一键导入");
  }
  const metadata: WeComBatchMetadata = {
    runId: operation.runId,
    batchKey: operation.batchKey,
    conversationId: operation.conversationId,
    conversationTitle: operation.conversationTitle,
    candidateStudentIds,
    messageIds: operation.receipts.map((receipt) => receipt.messageId),
  };
  const prepared = await prepareWeComBatch(prisma, metadata);
  const result = await applyWeComLedgerBatch(
    prisma,
    prepared.id,
    metadata,
    operation.candidateJson,
  );
  await refreshRunSummary(prisma, operation.runId);
  return result;
}

export async function retryWeComBatchExtraction(
  prisma: PrismaClient,
  operationId: string,
) {
  const operation = await prisma.weComImportOperation.findFirst({
    where: {
      id: operationId,
      status: { in: ["needs_review", "failed"] },
      candidateJson: null,
    },
    select: { id: true, runId: true },
  });
  if (!operation) throw new Error("这个批次没有可重新提取的消息");
  await prisma.$transaction([
    prisma.weComMessageReceipt.updateMany({
      where: { operationId, status: { in: ["needs_review", "failed"] } },
      data: {
        status: "pending",
        operationId: null,
        processedAt: null,
        lastError: null,
      },
    }),
    prisma.weComImportOperation.update({
      where: { id: operationId },
      data: {
        status: "retry_requested",
        attemptCount: 0,
        failureCode: null,
        completedAt: new Date(),
      },
    }),
  ]);
  await refreshRunSummary(prisma, operation.runId);
  return { requeued: true };
}

export async function ignoreWeComBatchCandidate(
  prisma: PrismaClient,
  operationId: string,
) {
  const operation = await prisma.weComImportOperation.findFirst({
    where: { id: operationId, status: { in: ["needs_review", "failed"] } },
    select: { id: true, runId: true },
  });
  if (!operation) throw new Error("这个批次已处理或不存在");
  await prisma.$transaction([
    prisma.weComMessageReceipt.updateMany({
      where: {
        operationId,
        status: { in: ["pending", "extracting", "needs_review", "failed"] },
      },
      data: {
        status: "ignored",
        processedAt: new Date(),
        lastError: null,
      },
    }),
    prisma.weComImportOperation.update({
      where: { id: operationId },
      data: {
        status: "ignored",
        candidateJson: null,
        completedAt: new Date(),
      },
    }),
  ]);
  await refreshRunSummary(prisma, operation.runId);
  return { ignored: true };
}

export async function pruneWeComRollbackJournal(prisma: PrismaClient) {
  const cutoff = new Date(Date.now() - ROLLBACK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const retained = await prisma.weComImportRun.findMany({
    where: { status: { not: "running" } },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true },
  });
  const removeRunIds = retained
    .filter((run, index) => index >= ROLLBACK_RETENTION_OPERATIONS || run.startedAt < cutoff)
    .map((run) => run.id);
  if (removeRunIds.length === 0) return;
  const operationIds = (await prisma.weComImportOperation.findMany({
    where: { runId: { in: removeRunIds } },
    select: { id: true },
  })).map((operation) => operation.id);
  await prisma.$transaction([
    prisma.weComMessageReceipt.updateMany({
      where: {
        operationId: { in: operationIds },
        status: "needs_review",
      },
      data: {
        status: "failed",
        lastError: "待复核候选已超过保留期限，将在下次运行重新提取",
      },
    }),
    prisma.weComImportRun.deleteMany({ where: { id: { in: removeRunIds } } }),
  ]);
}

export const weComRollbackRetention = {
  days: ROLLBACK_RETENTION_DAYS,
  operations: ROLLBACK_RETENTION_OPERATIONS,
};
