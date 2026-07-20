import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { INTERNAL_ATTENTION_LABELS, type AttentionSignalCandidate } from "@/lib/attention-labels";
import { planWeComCommunicationImport, type WeComImportResult } from "@/services/wecom-import-service";

const ROLLBACK_RETENTION_DAYS = 30;
const ROLLBACK_RETENTION_OPERATIONS = 30;

export interface WeComBatchMetadata {
  runId: string;
  batchKey: string;
  conversationId: string;
  conversationTitle: string;
  candidateStudentIds: string[];
  messageIds: string[];
}

export async function prepareWeComBatch(
  prisma: PrismaClient,
  metadata: WeComBatchMetadata,
) {
  const previousCandidate = await prisma.weComImportOperation.findFirst({
    where: {
      batchKey: metadata.batchKey,
      status: "failed",
      candidateJson: { not: null },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, candidateJson: true, extractedAt: true },
  });
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
      candidateJson: previousCandidate?.candidateJson,
      extractedAt: previousCandidate?.extractedAt,
    },
    update: {
      status: "processing",
      messageCount: metadata.messageIds.length,
      candidateStudentIds: JSON.stringify(metadata.candidateStudentIds),
      rolledBackAt: null,
    },
  });
  await prisma.weComMessageReceipt.updateMany({
    where: {
      conversationId: metadata.conversationId,
      messageId: { in: metadata.messageIds },
    },
    data: { status: "extracting", operationId: operation.id, lastError: null },
  });
  if (previousCandidate && previousCandidate.id !== operation.id) {
    await prisma.weComImportOperation.update({
      where: { id: previousCandidate.id },
      data: { candidateJson: null },
    });
  }
  return operation;
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
) {
  const message = error instanceof Error && error.message.includes("合法的企微候选 JSON")
    ? "LLM 返回格式异常，可安全重试"
    : "批次处理失败，可安全重试";
  await prisma.$transaction([
    prisma.weComImportOperation.update({ where: { id: operationId }, data: { status: "failed" } }),
    prisma.weComMessageReceipt.updateMany({
      where: { conversationId, messageId: { in: messageIds } },
      data: { status: "failed", lastError: message },
    }),
  ]);
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
