import { readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { createDatabaseBackup } from "@/services/database-backup-service";
import {
  pruneWeComRollbackJournal,
  weComRollbackRetention,
} from "@/services/wecom-import-ledger-service";

const SAFETY_BACKUP_LIMIT = 3;
const SAFETY_BACKUP_PREFIX = "pre-wecom-rollback";

interface RollbackOptions {
  createSafetyBackup?: () => Promise<void>;
}

function shanghaiDayRange(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期格式必须是 YYYY-MM-DD");
  const [year, month, day] = date.split("-").map(Number);
  const validation = new Date(Date.UTC(year, month - 1, day));
  if (
    validation.getUTCFullYear() !== year
    || validation.getUTCMonth() !== month - 1
    || validation.getUTCDate() !== day
  ) {
    throw new Error("日期无效");
  }
  const start = new Date(`${date}T00:00:00+08:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

async function pruneRollbackSafetyBackups(backupPath: string) {
  const archiveDir = dirname(backupPath);
  const entries = await readdir(archiveDir, { withFileTypes: true });
  const backups = await Promise.all(entries
    .filter((entry) => entry.isFile()
      && entry.name.startsWith(`${SAFETY_BACKUP_PREFIX}_`)
      && entry.name.endsWith(".db"))
    .map(async (entry) => ({
      path: join(archiveDir, entry.name),
      modifiedAt: (await stat(join(archiveDir, entry.name))).mtimeMs,
    })));
  backups.sort((a, b) => b.modifiedAt - a.modifiedAt);
  await Promise.all(backups.slice(SAFETY_BACKUP_LIMIT).flatMap((backup) => [
    rm(backup.path, { force: true }),
    rm(`${backup.path}.json`, { force: true }),
  ]));
}

async function createRollbackSafetyBackup() {
  const backup = await createDatabaseBackup({ prefix: SAFETY_BACKUP_PREFIX });
  await pruneRollbackSafetyBackups(backup.backupPath);
}

export async function listWeComRollbackOperations(prisma: PrismaClient) {
  await pruneWeComRollbackJournal(prisma);
  const [runs, receiptGroups, state] = await Promise.all([
    prisma.weComImportRun.findMany({
      where: { status: { not: "running" } },
      orderBy: { startedAt: "desc" },
      take: weComRollbackRetention.operations,
      include: {
        operations: {
          select: {
            id: true,
            conversationTitle: true,
            status: true,
            messageCount: true,
            candidateJson: true,
            attemptCount: true,
            failureCode: true,
            modelName: true,
            finishReason: true,
            promptVersion: true,
            reasoningTokens: true,
            completionTokens: true,
            responseCharacters: true,
          },
        },
      },
    }),
    prisma.weComMessageReceipt.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.weComImportState.findUnique({
      where: { id: "default" },
      select: {
        lastSucceededUntil: true,
        activeRunId: true,
        activeRunStartedAt: true,
      },
    }),
  ]);
  return {
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      messageCount: run.messageCount,
      batchCount: run.batchCount,
      communicationCount: run.communicationCount,
      labelCount: run.labelCount,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      rolledBackAt: run.rolledBackAt,
      conversations: [...new Set(run.operations.map((operation) => operation.conversationTitle))],
      needsReviewCount: run.operations.filter((operation) => operation.status === "needs_review").length,
      failedBatchCount: run.operations.filter((operation) => operation.status === "failed").length,
      attentionBatches: run.operations
        .filter((operation) => (
          operation.status === "needs_review" || operation.status === "failed"
        ))
        .map((operation) => ({
          id: operation.id,
          conversationTitle: operation.conversationTitle,
          status: operation.status,
          messageCount: operation.messageCount,
          canRetry: Boolean(operation.candidateJson),
          canReextract: !operation.candidateJson,
          attemptCount: operation.attemptCount,
          failureCode: operation.failureCode,
          modelName: operation.modelName,
          finishReason: operation.finishReason,
          promptVersion: operation.promptVersion,
          reasoningTokens: operation.reasoningTokens,
          completionTokens: operation.completionTokens,
          responseCharacters: operation.responseCharacters,
        })),
    })),
    receiptCounts: Object.fromEntries(receiptGroups.map((group) => [
      group.status,
      group._count._all,
    ])),
    state,
    retention: {
      days: weComRollbackRetention.days,
      runs: weComRollbackRetention.operations,
      safetyBackups: SAFETY_BACKUP_LIMIT,
    },
  };
}

async function rollbackOperationsInTransaction(
  tx: Prisma.TransactionClient,
  operationIds: string[],
) {
  const operations = await tx.weComImportOperation.findMany({
    where: { id: { in: operationIds }, status: "complete" },
    include: { changes: { orderBy: { createdAt: "desc" } } },
  });
  let communicationCount = 0;
  let labelCount = 0;
  const labelPairs = new Map<string, { studentId: string; labelId: string }>();

  for (const operation of operations) {
    for (const change of operation.changes) {
      if (change.entityType === "communication") {
        communicationCount += (await tx.communication.deleteMany({
          where: { id: change.entityId },
        })).count;
      }
      if (
        change.entityType === "student_label_claim"
        && change.studentId
        && change.labelId
      ) {
        labelPairs.set(change.entityId, {
          studentId: change.studentId,
          labelId: change.labelId,
        });
      }
    }
    await tx.weComMessageReceipt.updateMany({
      where: { operationId: operation.id, status: "imported" },
      data: { status: "rolled_back", processedAt: null },
    });
    await tx.weComImportOperation.update({
      where: { id: operation.id },
      data: { status: "rolled_back", rolledBackAt: new Date() },
    });
  }

  for (const [entityId, pair] of labelPairs) {
    const createdByImport = await tx.weComImportChange.findFirst({
      where: {
        entityType: "student_label_created",
        entityId,
      },
      select: { id: true },
    });
    if (!createdByImport) continue;
    const activeClaim = await tx.weComImportChange.findFirst({
      where: {
        entityType: "student_label_claim",
        entityId,
        operation: { status: "complete" },
      },
      select: { id: true },
    });
    if (activeClaim) continue;
    labelCount += (await tx.studentLabel.deleteMany({
      where: { studentId: pair.studentId, labelId: pair.labelId },
    })).count;
  }

  const runIds = [...new Set(operations.map((operation) => operation.runId))];
  for (const runId of runIds) {
    const remaining = await tx.weComImportOperation.count({
      where: {
        runId,
        status: { in: ["complete", "needs_review", "failed", "processing"] },
      },
    });
    await tx.weComImportRun.update({
      where: { id: runId },
      data: remaining === 0
        ? { status: "rolled_back", rolledBackAt: new Date() }
        : { status: "partially_rolled_back", rolledBackAt: null },
    });
  }

  return {
    runCount: runIds.length,
    batchCount: operations.length,
    communicationCount,
    labelCount,
  };
}

async function writeRollbackLog(
  prisma: PrismaClient,
  result: {
    runCount: number;
    batchCount: number;
    communicationCount: number;
    labelCount: number;
  },
) {
  if (result.batchCount === 0) return;
  try {
    await prisma.systemLog.create({
      data: {
        action: "wecom.rollback",
        targetType: "System",
        targetName: "企微增量导入",
        detail: JSON.stringify({
          runs: result.runCount,
          batches: result.batchCount,
          communications: result.communicationCount,
          labels: result.labelCount,
        }),
      },
    });
  } catch {
    // Auxiliary logging must not undo a successful business rollback.
  }
}

async function performRollback(
  prisma: PrismaClient,
  operationIds: string[],
  options: RollbackOptions = {},
) {
  if (operationIds.length === 0) {
    return {
      runCount: 0,
      batchCount: 0,
      communicationCount: 0,
      labelCount: 0,
      safetyBackupCreated: false,
    };
  }
  await (options.createSafetyBackup ?? createRollbackSafetyBackup)();
  const result = await prisma.$transaction((tx) => (
    rollbackOperationsInTransaction(tx, operationIds)
  ));
  await writeRollbackLog(prisma, result);
  return { ...result, safetyBackupCreated: true };
}

export async function rollbackWeComRun(
  prisma: PrismaClient,
  runId: string,
  options: RollbackOptions = {},
) {
  if (!runId.trim()) throw new Error("缺少回滚操作 ID");
  const operationIds = (await prisma.weComImportOperation.findMany({
    where: { runId, status: "complete" },
    select: { id: true },
  })).map((operation) => operation.id);
  return performRollback(prisma, operationIds, options);
}

export async function rollbackWeComOperation(
  prisma: PrismaClient,
  operationId: string,
  options: RollbackOptions = {},
) {
  if (!operationId.trim()) throw new Error("缺少回滚批次 ID");
  const operation = await prisma.weComImportOperation.findFirst({
    where: { id: operationId, status: "complete" },
    select: { id: true },
  });
  return performRollback(prisma, operation ? [operation.id] : [], options);
}

export async function rollbackWeComDate(
  prisma: PrismaClient,
  date: string,
  options: RollbackOptions = {},
) {
  const { start, end } = shanghaiDayRange(date);
  const operationIds = (await prisma.weComImportOperation.findMany({
    where: {
      status: "complete",
      run: { completedAt: { gte: start, lt: end } },
    },
    select: { id: true },
  })).map((operation) => operation.id);
  return performRollback(prisma, operationIds, options);
}

export const rollbackSafetyRetention = {
  backups: SAFETY_BACKUP_LIMIT,
  prefix: basename(SAFETY_BACKUP_PREFIX),
};
