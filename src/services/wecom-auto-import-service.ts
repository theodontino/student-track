import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createLLMClient } from "@/lib/llm";
import { generateWeComBridgeJson } from "@/services/wecom-bridge-service";
import {
  applyWeComLedgerBatch,
  failWeComBatch,
  prepareWeComBatch,
  pruneWeComRollbackJournal,
  saveWeComBatchCandidate,
} from "@/services/wecom-import-ledger-service";
import type { WeComImportResult } from "@/services/wecom-import-service";
import { preflightWeComCatchSync, resolveWeComCatchPaths } from "@/services/local-tool-status-service";
import { runWeComCatchCommand, type WeComCatchResult } from "@/services/wecomcatch-service";

const FIRST_RUN_LOOKBACK_DAYS = 30;
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;
const RUN_LEASE_MS = 7 * 60 * 60 * 1000;
const MAX_BATCH_CHARACTERS = 20_000;
const MAX_SYNC_WAIT_MS = 6 * 60 * 60 * 1000;
const PROMPT_VERSION = "wecom-incremental-v2";

interface WeComMessage {
  id?: string;
  sent_at?: string | null;
  time_context?: string | null;
  sender?: string | null;
  direction?: string | null;
  content?: string | null;
}

interface KnownReceipt {
  contentHash: string;
  status: string;
}

interface ClaimedRun {
  runId: string;
  since: Date;
  stateInitializedAfter: Date;
}

interface SourceMessage {
  id: string;
  text: string;
  sentAt: Date;
  contentHash: string;
}

interface SourceConversation {
  id: string;
  title: string;
  candidateStudentIds: string[];
  messages: SourceMessage[];
}

interface ExtractionBatch {
  batchKey: string;
  conversationId: string;
  conversationTitle: string;
  candidateStudentIds: string[];
  text: string;
  messages: SourceMessage[];
  messageIds: string[];
}

export interface WeComAutoImportProgress {
  type: "progress";
  phase: "preflight" | "syncing" | "exporting" | "extracting" | "importing" | "complete";
  progress: number;
  message: string;
  detail?: string;
}

export interface WeComAutoImportComplete {
  type: "complete";
  result: WeComImportResult;
  conversationCount: number;
  messageCount: number;
  batchCount: number;
  since: string;
}

export type WeComAutoImportEvent = WeComAutoImportProgress | WeComAutoImportComplete;

interface AutoImportOptions {
  runCommand?: typeof runWeComCatchCommand;
  emit?: (event: WeComAutoImportEvent) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  runtimeDir?: string;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function commandPayload(result: WeComCatchResult) {
  return objectValue(result.parsed);
}

function syncDecision(result: WeComCatchResult) {
  const payload = commandPayload(result);
  const job = objectValue(payload.job);
  return String(payload.decision || job.decision || "");
}

function syncProgress(result: WeComCatchResult) {
  const payload = commandPayload(result);
  const batch = objectValue(payload.batch);
  const completed = Number(batch.completed || 0);
  const total = Number(batch.task_count || payload.target_count || 0);
  return { completed, total, ratio: total > 0 ? Math.max(0, Math.min(1, completed / total)) : 0 };
}

function parseMessage(line: string): WeComMessage | null {
  try {
    return JSON.parse(line) as WeComMessage;
  } catch {
    return null;
  }
}

function messageTime(message: WeComMessage) {
  const parsed = message.sent_at ? new Date(message.sent_at) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function formatMessage(message: WeComMessage, messageId: string) {
  const speaker = message.sender?.trim()
    || (message.direction === "outgoing" ? "老师" : message.direction === "incoming" ? "对方" : "未知");
  const when = message.sent_at || message.time_context || "时间未知";
  return `[消息ID:${messageId}][${when}] ${speaker}: ${(message.content || "").trim()}`;
}

export async function collectIncrementalWeComSources(
  prisma: PrismaClient,
  runtimeDir: string,
  since: Date,
  until: Date,
  knownReceipts: ReadonlyMap<string, KnownReceipt> = new Map(),
): Promise<{ conversations: SourceConversation[]; messageCount: number }> {
  const students = await prisma.student.findMany({ select: { id: true, name: true } });
  const conversationsDir = path.join(runtimeDir, "exports", "conversations");
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(conversationsDir, { withFileTypes: true });
  } catch {
    return { conversations: [], messageCount: 0 };
  }

  const conversations: SourceConversation[] = [];
  let messageCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(conversationsDir, entry.name);
    let title = "";
    try {
      title = (await readFile(path.join(directory, "archive.md"), "utf8"))
        .split("\n", 1)[0]
        .replace(/^#\s*/, "")
        .trim();
    } catch {
      continue;
    }
    const matchingStudents = students
      .filter((student) => student.name.trim() && title.includes(student.name.trim()));
    const longestNameLength = matchingStudents.reduce(
      (length, student) => Math.max(length, student.name.trim().length),
      0,
    );
    const candidateStudentIds = matchingStudents
      .filter((student) => student.name.trim().length === longestNameLength)
      .map((student) => student.id);
    if (candidateStudentIds.length !== 1) continue;

    let lines: string[];
    try {
      lines = (await readFile(path.join(directory, "messages.jsonl"), "utf8")).split("\n").filter(Boolean);
    } catch {
      continue;
    }

    const messages: SourceMessage[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const message = parseMessage(lines[index]);
      const content = message?.content?.trim();
      const sentAt = message ? messageTime(message) : null;
      if (!message || !content || !sentAt || sentAt <= since || sentAt > until) continue;
      const contentHash = hash([
        message.sent_at || "",
        message.sender || "",
        message.direction || "",
        content,
      ].join("\n"));
      const id = typeof message.id === "string" && message.id.trim()
        ? message.id.trim()
        : `fingerprint:${contentHash}`;
      const known = knownReceipts.get(`${entry.name}\0${id}`);
      const retryable = known && ["pending", "failed", "rolled_back"].includes(known.status);
      if (known && known.contentHash === contentHash && !retryable) continue;
      messages.push({ id, text: formatMessage(message, id), sentAt, contentHash });
    }
    if (messages.length === 0) continue;
    conversations.push({ id: entry.name, title, candidateStudentIds, messages });
    messageCount += messages.length;
  }
  return { conversations, messageCount };
}

function buildBatches(conversations: SourceConversation[]): ExtractionBatch[] {
  const batches: ExtractionBatch[] = [];
  for (const conversation of conversations) {
    const heading = `# 会话ID：${conversation.id}\n# 会话标题：${conversation.title}`;
    let text = heading;
    let messages: SourceMessage[] = [];
    const pushBatch = () => {
      if (messages.length === 0) return;
      const batchKey = hash(`${PROMPT_VERSION}\n${conversation.id}\n${messages.map((message) => `${message.id}:${message.contentHash}`).join("\n")}`);
      batches.push({
        batchKey,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        candidateStudentIds: conversation.candidateStudentIds,
        text,
        messages,
        messageIds: messages.map((message) => message.id),
      });
    };

    for (const message of conversation.messages) {
      const line = message.text.length > MAX_BATCH_CHARACTERS - heading.length - 2
        ? message.text.slice(-(MAX_BATCH_CHARACTERS - heading.length - 2))
        : message.text;
      if (messages.length > 0 && text.length + line.length + 1 > MAX_BATCH_CHARACTERS) {
        pushBatch();
        text = heading;
        messages = [];
      }
      text += `\n${line}`;
      messages.push(message);
    }
    pushBatch();
  }
  return batches;
}

function decorateRecords(records: unknown[], batch: ExtractionBatch) {
  const allowedMessageIds = new Set(batch.messageIds);
  return records.map((value) => {
    const record = objectValue(value);
    const source = objectValue(record.source);
    const messageIds = Array.isArray(source.messageIds)
      ? [...new Set(source.messageIds
        .filter((messageId): messageId is string => typeof messageId === "string")
        .map((messageId) => messageId.trim())
        .filter((messageId) => allowedMessageIds.has(messageId)))]
      : [];
    const matchedStudent = objectValue(record.matchedStudent);
    const studentIdentity = String(
      matchedStudent.id || matchedStudent.studentId || matchedStudent.name || "unknown",
    );
    return {
      ...record,
      sourceKey: `wecomcatch:${hash([
        batch.conversationId,
        ...[...messageIds].sort(),
        studentIdentity,
      ].join("\n"))}`,
      source: {
        ...source,
        conversationId: batch.conversationId,
        conversationTitle: batch.conversationTitle,
        messageIds,
      },
    };
  });
}

function emptyResult(): WeComImportResult {
  return {
    sourceLabel: "WeComCatch 增量导入",
    mode: "apply",
    communicationCandidateCount: 0,
    aiContextCandidateCount: 0,
    attentionCandidateCount: 0,
    importableCount: 0,
    createCount: 0,
    duplicateCount: 0,
    skippedCount: 0,
    createdCount: 0,
    createdLabelCount: 0,
    plans: [],
    skipped: [],
  };
}

function mergeResult(total: WeComImportResult, next: WeComImportResult) {
  for (const key of [
    "communicationCandidateCount", "aiContextCandidateCount", "attentionCandidateCount",
    "importableCount", "createCount", "duplicateCount", "skippedCount",
    "createdCount", "createdLabelCount",
  ] as const) total[key] += next[key];
  total.plans.push(...next.plans);
  total.skipped.push(...next.skipped);
}

export async function claimWeComAutoImportRun(
  prisma: PrismaClient,
  startedAt: Date,
): Promise<ClaimedRun> {
  const runId = randomUUID();
  const initializedAfter = new Date(
    startedAt.getTime() - FIRST_RUN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const state = await prisma.weComImportState.upsert({
    where: { id: "default" },
    create: { id: "default", initializedAfter },
    update: {},
  });
  const staleBefore = new Date(startedAt.getTime() - RUN_LEASE_MS);
  const claimed = await prisma.weComImportState.updateMany({
    where: {
      id: "default",
      OR: [
        { activeRunId: null },
        { activeRunStartedAt: { lt: staleBefore } },
      ],
    },
    data: { activeRunId: runId, activeRunStartedAt: startedAt },
  });
  if (claimed.count !== 1) {
    throw new Error("已有企微一键导入正在运行，请等待当前任务完成");
  }

  try {
    await prisma.$transaction([
      prisma.weComImportRun.updateMany({
        where: {
          id: state.activeRunId || "",
          status: "running",
          startedAt: { lt: staleBefore },
        },
        data: { status: "failed", completedAt: startedAt },
      }),
      prisma.weComImportOperation.updateMany({
        where: { status: "processing", startedAt: { lt: staleBefore } },
        data: { status: "failed", completedAt: startedAt },
      }),
      prisma.weComMessageReceipt.updateMany({
        where: { status: "extracting", updatedAt: { lt: staleBefore } },
        data: { status: "failed", lastError: "上次运行中断，可安全重试" },
      }),
    ]);
    const unresolved = await prisma.weComMessageReceipt.findFirst({
      where: {
        status: { in: ["pending", "failed", "rolled_back"] },
        sentAt: { not: null },
      },
      orderBy: { sentAt: "asc" },
      select: { sentAt: true },
    });
    const regularSince = state.lastSucceededUntil
      ? new Date(Math.max(
        state.initializedAfter.getTime(),
        state.lastSucceededUntil.getTime() - CURSOR_OVERLAP_MS,
      ))
      : state.initializedAfter;
    const since = unresolved?.sentAt && unresolved.sentAt < regularSince
      ? new Date(Math.max(
        state.initializedAfter.getTime(),
        unresolved.sentAt.getTime() - CURSOR_OVERLAP_MS,
      ))
      : regularSince;
    await prisma.weComImportRun.create({
      data: {
        id: runId,
        status: "running",
        windowStartedAt: since,
        windowEndedAt: startedAt,
      },
    });
    return { runId, since, stateInitializedAfter: state.initializedAfter };
  } catch (error) {
    await prisma.weComImportState.updateMany({
      where: { id: "default", activeRunId: runId },
      data: { activeRunId: null, activeRunStartedAt: null },
    });
    throw error;
  }
}

async function releaseWeComAutoImportRun(prisma: PrismaClient, runId: string) {
  await prisma.weComImportState.updateMany({
    where: { id: "default", activeRunId: runId },
    data: { activeRunId: null, activeRunStartedAt: null },
  });
}

async function refreshWeComAutoImportRun(prisma: PrismaClient, runId: string) {
  const refreshed = await prisma.weComImportState.updateMany({
    where: { id: "default", activeRunId: runId },
    data: { activeRunStartedAt: new Date() },
  });
  if (refreshed.count !== 1) throw new Error("企微导入运行锁已失效，本次处理已停止");
}

async function waitForWeComSync(
  runCommand: typeof runWeComCatchCommand,
  emit: (event: WeComAutoImportEvent) => void,
  sleep: (milliseconds: number) => Promise<void>,
  heartbeat: () => Promise<void>,
) {
  emit({ type: "progress", phase: "syncing", progress: 5, message: "正在扫描企微会话列表…" });
  const started = await runCommand("sync-start", { timeoutMs: 10 * 60 * 1000 });
  await heartbeat();
  if (syncDecision(started) === "run_export_next") return;

  const waitStartedAt = Date.now();
  while (Date.now() - waitStartedAt < MAX_SYNC_WAIT_MS) {
    const status = await runCommand("sync-status");
    await heartbeat();
    const decision = syncDecision(status);
    const progress = syncProgress(status);
    if (decision === "run_export_next") return;
    if (decision && decision !== "continue_waiting_and_poll") throw new Error(`WeComCatch 同步需要人工处理：${decision}`);
    emit({
      type: "progress",
      phase: "syncing",
      progress: 10 + Math.round(progress.ratio * 35),
      message: "正在拉取企微聊天记录…",
      detail: progress.total > 0 ? `${progress.completed}/${progress.total} 个会话` : "同步任务运行中",
    });
    await sleep(10_000);
  }
  throw new Error("WeComCatch 同步超时，请到手动入口检查同步状态");
}

export async function runWeComAutoImport(
  prisma: PrismaClient,
  options: AutoImportOptions = {},
): Promise<WeComAutoImportComplete> {
  const emit = (event: WeComAutoImportEvent) => {
    try {
      options.emit?.(event);
    } catch {
      // The browser may disconnect while the server-side import continues.
    }
  };
  const runCommand = options.runCommand ?? runWeComCatchCommand;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const runtimeDir = options.runtimeDir ?? resolveWeComCatchPaths().runtimeDir;

  emit({ type: "progress", phase: "preflight", progress: 2, message: "正在检查 WeComCatch 和 LLM 配置…" });
  const preflight = preflightWeComCatchSync();
  if (!preflight.ready) throw new Error(`WeComCatch 环境不可用：${preflight.blockers.join("；")}`);
  createLLMClient();
  const claimed = await claimWeComAutoImportRun(prisma, startedAt);
  try {
    await waitForWeComSync(
      runCommand,
      emit,
      sleep,
      () => refreshWeComAutoImportRun(prisma, claimed.runId),
    );
    emit({ type: "progress", phase: "exporting", progress: 48, message: "正在导出已完成会话…" });
    await runCommand("export", { timeoutMs: 10 * 60 * 1000 });
    await refreshWeComAutoImportRun(prisma, claimed.runId);

    const receiptRows = await prisma.weComMessageReceipt.findMany({
      select: { conversationId: true, messageId: true, contentHash: true, status: true },
    });
    const knownReceipts = new Map(receiptRows.map((receipt) => [
      `${receipt.conversationId}\0${receipt.messageId}`,
      receipt,
    ]));
    const { conversations, messageCount } = await collectIncrementalWeComSources(
      prisma,
      runtimeDir,
      claimed.since,
      startedAt,
      knownReceipts,
    );
    const batches = buildBatches(conversations);
    const totalResult = emptyResult();

    for (const conversation of conversations) {
      for (const message of conversation.messages) {
        await prisma.weComMessageReceipt.upsert({
          where: {
            conversationId_messageId: {
              conversationId: conversation.id,
              messageId: message.id,
            },
          },
          create: {
            messageId: message.id,
            conversationId: conversation.id,
            sentAt: message.sentAt,
            contentHash: message.contentHash,
            status: "pending",
            promptVersion: PROMPT_VERSION,
          },
          update: {
            sentAt: message.sentAt,
            contentHash: message.contentHash,
            status: "pending",
            promptVersion: PROMPT_VERSION,
          },
        });
      }
    }

    if (batches.length === 0) {
      emit({ type: "progress", phase: "extracting", progress: 85, message: "没有需要提取的新聊天记录" });
    }
    for (let index = 0; index < batches.length; index += 1) {
      await refreshWeComAutoImportRun(prisma, claimed.runId);
      const batch = { ...batches[index], runId: claimed.runId };
      emit({
        type: "progress",
        phase: "extracting",
        progress: 52 + Math.round((index / batches.length) * 38),
        message: "LLM 正在整理增量家校沟通…",
        detail: `${index + 1}/${batches.length} 批 · ${batch.conversationTitle}`,
      });
      const operation = await prepareWeComBatch(prisma, batch);
      try {
        let candidateJson = operation.candidateJson;
        if (!candidateJson) {
          const generated = await generateWeComBridgeJson(prisma, {
            sourceText: batch.text,
            candidateStudentIds: batch.candidateStudentIds,
          }, {
            onRetry: () => emit({
              type: "progress",
              phase: "extracting",
              progress: 52 + Math.round((index / batches.length) * 38),
              message: "LLM 返回格式异常，正在自动修复…",
              detail: `${index + 1}/${batches.length} 批（重试 1/1）`,
            }),
          });
          const records = objectValue(generated.bridgeJson).records;
          candidateJson = JSON.stringify({
            source: "wecomcatch",
            mode: "candidateOnly",
            records: decorateRecords(Array.isArray(records) ? records : [], batch),
          });
          await saveWeComBatchCandidate(prisma, operation.id, candidateJson);
        }
        emit({
          type: "progress",
          phase: "importing",
          progress: 90 + Math.round((index / Math.max(1, batches.length)) * 8),
          message: "正在写入增量记录…",
          detail: `${index + 1}/${batches.length} 批`,
        });
        mergeResult(
          totalResult,
          await applyWeComLedgerBatch(prisma, operation.id, batch, candidateJson),
        );
      } catch (error) {
        await failWeComBatch(
          prisma,
          operation.id,
          batch.conversationId,
          batch.messageIds,
          error,
        );
        throw error;
      }
    }

    await prisma.$transaction([
      prisma.weComImportRun.update({
        where: { id: claimed.runId },
        data: {
          status: totalResult.skippedCount > 0 ? "attention_required" : "complete",
          conversationCount: conversations.length,
          messageCount,
          batchCount: batches.length,
          communicationCount: totalResult.createdCount,
          labelCount: totalResult.createdLabelCount,
          completedAt: new Date(),
        },
      }),
      prisma.weComImportState.update({
        where: { id: "default" },
        data: {
          lastSucceededUntil: startedAt,
          activeRunId: null,
          activeRunStartedAt: null,
        },
      }),
    ]);
    await pruneWeComRollbackJournal(prisma);
    const completed: WeComAutoImportComplete = {
      type: "complete",
      result: totalResult,
      conversationCount: conversations.length,
      messageCount,
      batchCount: batches.length,
      since: claimed.since.toISOString(),
    };
    emit({ type: "progress", phase: "complete", progress: 100, message: "企微增量记录已处理完成" });
    emit(completed);
    return completed;
  } catch (error) {
    await prisma.weComImportRun.updateMany({
      where: { id: claimed.runId, status: "running" },
      data: { status: "failed", completedAt: new Date() },
    });
    throw error;
  } finally {
    await releaseWeComAutoImportRun(prisma, claimed.runId);
  }
}
