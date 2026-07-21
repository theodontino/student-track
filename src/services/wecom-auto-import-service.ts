import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createLLMClient } from "@/lib/llm";
import {
  generateWeComBridgeJson,
  WeComExtractionError,
} from "@/services/wecom-bridge-service";
import {
  applyWeComLedgerBatch,
  failWeComBatch,
  markWeComBatchSplit,
  prepareWeComBatch,
  pruneWeComRollbackJournal,
  saveWeComBatchDiagnostics,
  saveWeComBatchCandidate,
} from "@/services/wecom-import-ledger-service";
import type { WeComImportResult } from "@/services/wecom-import-service";
import { preflightWeComCatchSync, resolveWeComCatchPaths } from "@/services/local-tool-status-service";
import { runWeComCatchCommand, type WeComCatchResult } from "@/services/wecomcatch-service";
import { rollbackWeComRun } from "@/services/wecom-rollback-service";
import { WeComRunCancelledError, type WeComCancelMode } from "@/services/wecom-run-control";
export type { WeComCancelMode } from "@/services/wecom-run-control";

const FIRST_RUN_LOOKBACK_DAYS = 30;
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;
export const WECOM_RUN_LEASE_MS = 15 * 60 * 1000;
const MAX_BATCH_CHARACTERS = 8_000;
const MAX_BATCH_MESSAGES = 30;
const MAX_SINGLE_MESSAGE_CHARACTERS = 20_000;
const CONVERSATION_GAP_MS = 6 * 60 * 60 * 1000;
const MAX_SYNC_WAIT_MS = 6 * 60 * 60 * 1000;
export const WECOM_PROMPT_VERSION = "wecom-grounded-v4";

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

export interface SourceMessage {
  id: string;
  text: string;
  content: string;
  sentAt: Date;
  contentHash: string;
}

export interface SourceConversation {
  id: string;
  title: string;
  candidateStudentIds: string[];
  messages: SourceMessage[];
}

export interface ExtractionBatch {
  batchKey: string;
  conversationId: string;
  conversationTitle: string;
  candidateStudentIds: string[];
  text: string;
  messages: SourceMessage[];
  messageIds: string[];
  requiresManualReview: boolean;
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
  attentionBatchCount: number;
  since: string;
}

export type WeComAutoImportEvent = WeComAutoImportProgress | WeComAutoImportComplete | WeComAutoImportCancelled;

export interface WeComAutoImportCancelled {
  type: "cancelled";
  runId: string;
  rolledBack: boolean;
}

export type WeComAutoImportOutcome = WeComAutoImportComplete | WeComAutoImportCancelled;

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
      messages.push({ id, text: formatMessage(message, id), content, sentAt, contentHash });
    }
    if (messages.length === 0) continue;
    conversations.push({ id: entry.name, title, candidateStudentIds, messages });
    messageCount += messages.length;
  }
  return { conversations, messageCount };
}

function shanghaiDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function createExtractionBatch(
  conversation: Pick<SourceConversation, "id" | "title" | "candidateStudentIds">,
  messages: SourceMessage[],
): ExtractionBatch {
  const orderedMessages = [...messages].sort((left, right) => (
    left.sentAt.getTime() - right.sentAt.getTime() || left.id.localeCompare(right.id)
  ));
  const heading = `# 会话ID：${conversation.id}\n# 会话标题：${conversation.title}`;
  const batchKey = hash(`${WECOM_PROMPT_VERSION}\n${conversation.id}\n${orderedMessages
    .map((message) => `${message.sentAt.toISOString()}:${message.id}:${message.contentHash}`)
    .join("\n")}`);
  return {
    batchKey,
    conversationId: conversation.id,
    conversationTitle: conversation.title,
    candidateStudentIds: conversation.candidateStudentIds,
    text: `${heading}\n${orderedMessages.map((message) => message.text).join("\n")}`,
    messages: orderedMessages,
    messageIds: orderedMessages.map((message) => message.id),
    requiresManualReview: orderedMessages.some((message) => (
      message.text.length > MAX_SINGLE_MESSAGE_CHARACTERS
    )),
  };
}

export function buildWeComExtractionBatches(conversations: SourceConversation[]): ExtractionBatch[] {
  const batches: ExtractionBatch[] = [];
  for (const conversation of conversations) {
    const ordered = [...conversation.messages].sort((left, right) => (
      left.sentAt.getTime() - right.sentAt.getTime() || left.id.localeCompare(right.id)
    ));
    let messages: SourceMessage[] = [];
    const pushBatch = () => {
      if (messages.length === 0) return;
      batches.push(createExtractionBatch(conversation, messages));
      messages = [];
    };

    for (const message of ordered) {
      const previous = messages.at(-1);
      const crossedConversationBoundary = previous && (
        shanghaiDate(previous.sentAt) !== shanghaiDate(message.sentAt)
        || message.sentAt.getTime() - previous.sentAt.getTime() > CONVERSATION_GAP_MS
      );
      const currentCharacters = messages.reduce((sum, item) => sum + item.text.length + 1, 0);
      const crossedSizeBoundary = messages.length > 0 && (
        messages.length >= MAX_BATCH_MESSAGES
        || currentCharacters + message.text.length + 1 > MAX_BATCH_CHARACTERS
      );
      if (crossedConversationBoundary || crossedSizeBoundary) {
        pushBatch();
      }
      messages.push(message);
      if (message.text.length > MAX_BATCH_CHARACTERS) pushBatch();
    }
    pushBatch();
  }
  return batches;
}

export function splitWeComExtractionBatch(batch: ExtractionBatch): [ExtractionBatch, ExtractionBatch] | null {
  if (batch.messages.length < 2) return null;
  const middle = Math.ceil(batch.messages.length / 2);
  const conversation = {
    id: batch.conversationId,
    title: batch.conversationTitle,
    candidateStudentIds: batch.candidateStudentIds,
  };
  return [
    createExtractionBatch(conversation, batch.messages.slice(0, middle)),
    createExtractionBatch(conversation, batch.messages.slice(middle)),
  ];
}

export function decorateGroundedWeComRecords(records: unknown[], batch: ExtractionBatch) {
  const allowedMessageIds = new Set(batch.messageIds);
  return records.map((value) => {
    const record = objectValue(value);
    const messageIds = Array.isArray(record.messageIds)
      ? [...new Set(record.messageIds
        .filter((messageId): messageId is string => typeof messageId === "string")
        .map((messageId) => messageId.trim())
        .filter((messageId) => allowedMessageIds.has(messageId)))]
      : [];
    const matchedStudent = objectValue(record.matchedStudent);
    const occurredAt = batch.messages
      .filter((message) => messageIds.includes(message.id))
      .reduce<Date | null>((latest, message) => !latest || message.sentAt > latest ? message.sentAt : latest, null);
    const studentIdentity = String(
      matchedStudent.id || matchedStudent.studentId || matchedStudent.name || "unknown",
    );
    return {
      kind: "communication",
      sourceKey: `wecomcatch:${hash([
        batch.conversationId,
        ...[...messageIds].sort(),
        studentIdentity,
      ].join("\n"))}`,
      source: {
        conversationId: batch.conversationId,
        conversationTitle: batch.conversationTitle,
        messageIds,
      },
      matchedStudent,
      occurredAt: occurredAt?.toISOString() ?? "",
      sessionCode: null,
      target: "家长",
      summary: String(record.factualSummary || ""),
      summaryForChemTrack: String(record.factualSummary || ""),
      feedbackContext: { toneHint: "", nextAction: "" },
      attentionSignals: [],
      confidence: record.confidence,
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
  const staleBefore = new Date(startedAt.getTime() - WECOM_RUN_LEASE_MS);
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
        data: { status: "interrupted", completedAt: startedAt },
      }),
      prisma.weComImportOperation.updateMany({
        where: { status: "processing", startedAt: { lt: staleBefore } },
        data: { status: "interrupted", completedAt: startedAt },
      }),
      prisma.weComMessageReceipt.updateMany({
        where: { status: "extracting", updatedAt: { lt: staleBefore } },
        data: { status: "pending", operationId: null, processedAt: null, lastError: "上次运行中断，已恢复为待处理" },
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
  const run = await prisma.weComImportRun.findUnique({
    where: { id: runId },
    select: { cancelRequestedAt: true, cancelMode: true },
  });
  if (run?.cancelRequestedAt) {
    throw new WeComRunCancelledError(
      runId,
      run.cancelMode === "stop_and_rollback" ? "stop_and_rollback" : "stop",
    );
  }
  const refreshed = await prisma.weComImportState.updateMany({
    where: { id: "default", activeRunId: runId },
    data: { activeRunStartedAt: new Date() },
  });
  if (refreshed.count !== 1) throw new Error("企微导入运行锁已失效，本次处理已停止");
}

async function finalizeCancelledRun(
  prisma: PrismaClient,
  runId: string,
  status: "cancelled" | "interrupted",
) {
  const operations = await prisma.weComImportOperation.findMany({
    where: { runId },
    select: { id: true, status: true, communicationCount: true, labelCount: true },
  });
  const processingIds = operations.filter((operation) => operation.status === "processing").map((operation) => operation.id);
  await prisma.$transaction([
    prisma.weComMessageReceipt.updateMany({
      where: { operationId: { in: processingIds }, status: "extracting" },
      data: { status: "pending", operationId: null, processedAt: null, lastError: null },
    }),
    prisma.weComImportOperation.updateMany({
      where: { id: { in: processingIds } },
      data: { status, candidateJson: null, completedAt: new Date() },
    }),
    prisma.weComImportRun.update({
      where: { id: runId },
      data: {
        status,
        communicationCount: operations
          .filter((operation) => operation.status === "complete")
          .reduce((sum, operation) => sum + operation.communicationCount, 0),
        labelCount: operations
          .filter((operation) => operation.status === "complete")
          .reduce((sum, operation) => sum + operation.labelCount, 0),
        completedAt: new Date(),
      },
    }),
    prisma.weComImportState.updateMany({
      where: { id: "default", activeRunId: runId },
      data: { activeRunId: null, activeRunStartedAt: null },
    }),
  ]);
}

export async function requestWeComAutoImportCancellation(
  prisma: PrismaClient,
  mode: WeComCancelMode,
) {
  const state = await prisma.weComImportState.findUnique({
    where: { id: "default" },
    select: { activeRunId: true, activeRunStartedAt: true },
  });
  if (!state?.activeRunId) throw new Error("当前没有正在运行的企微导入");
  const runId = state.activeRunId;
  await prisma.weComImportRun.update({
    where: { id: runId },
    data: { cancelRequestedAt: new Date(), cancelMode: mode },
  });
  const stale = !state.activeRunStartedAt
    || state.activeRunStartedAt.getTime() < Date.now() - WECOM_RUN_LEASE_MS;
  if (stale) {
    await finalizeCancelledRun(prisma, runId, "interrupted");
    if (mode === "stop_and_rollback") await rollbackWeComRun(prisma, runId);
  }
  return { accepted: true, runId, staleRecovered: stale, rollbackRequested: mode === "stop_and_rollback" };
}

export async function getWeComAutoImportStatus(prisma: PrismaClient) {
  const state = await prisma.weComImportState.findUnique({
    where: { id: "default" },
    select: { activeRunId: true, activeRunStartedAt: true, lastSucceededUntil: true },
  });
  const run = state?.activeRunId
    ? await prisma.weComImportRun.findUnique({
      where: { id: state.activeRunId },
      include: { operations: { include: { receipts: { select: { conversationId: true, messageId: true, status: true } } } } },
    })
    : await prisma.weComImportRun.findFirst({
      orderBy: { startedAt: "desc" },
      include: { operations: { include: { receipts: { select: { conversationId: true, messageId: true, status: true } } } } },
    });
  if (!run) return { active: false, run: null, lastSucceededUntil: state?.lastSucceededUntil ?? null };

  const receiptStatuses = new Map<string, string>();
  for (const operation of run.operations) {
    for (const receipt of operation.receipts) {
      receiptStatuses.set(`${receipt.conversationId}\0${receipt.messageId}`, receipt.status);
    }
  }
  const counts: Record<string, number> = {};
  for (const status of receiptStatuses.values()) counts[status] = (counts[status] ?? 0) + 1;
  counts.pending = Math.max(0, run.messageCount - receiptStatuses.size) + (counts.pending ?? 0);
  const terminal = ["imported", "no_value", "needs_review", "failed", "ignored"]
    .reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  const completeOperations = run.operations.filter((operation) => operation.status === "complete");
  return {
    active: state?.activeRunId === run.id,
    lastSucceededUntil: state?.lastSucceededUntil ?? null,
    run: {
      id: run.id,
      status: run.status,
      messageCount: run.messageCount,
      batchCount: run.batchCount,
      communicationCount: completeOperations.reduce((sum, operation) => sum + operation.communicationCount, 0),
      labelCount: completeOperations.reduce((sum, operation) => sum + operation.labelCount, 0),
      receiptCounts: counts,
      progress: run.messageCount > 0 ? Math.min(100, Math.round((terminal / run.messageCount) * 100)) : 0,
      cancelRequestedAt: run.cancelRequestedAt,
      cancelMode: run.cancelMode,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    },
  };
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
): Promise<WeComAutoImportOutcome> {
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
  createLLMClient("wecomExtraction");
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
    const batches = buildWeComExtractionBatches(conversations);
    const queue = [...batches];
    const totalResult = emptyResult();
    let hasAttention = false;
    let attentionBatchCount = 0;
    let attemptedGroundedBatches = 0;
    let consecutiveEvidenceFailures = 0;
    let evidenceFailuresInFirstTwenty = 0;

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
            promptVersion: WECOM_PROMPT_VERSION,
          },
          update: {
            sentAt: message.sentAt,
            contentHash: message.contentHash,
            status: "pending",
            promptVersion: WECOM_PROMPT_VERSION,
          },
        });
      }
    }

    await prisma.weComImportRun.update({
      where: { id: claimed.runId },
      data: {
        conversationCount: conversations.length,
        messageCount,
        batchCount: queue.length,
      },
    });

    if (queue.length === 0) {
      emit({ type: "progress", phase: "extracting", progress: 85, message: "没有需要提取的新聊天记录" });
    }
    for (let index = 0; index < queue.length; index += 1) {
      await refreshWeComAutoImportRun(prisma, claimed.runId);
      const batch = {
        ...queue[index],
        runId: claimed.runId,
        promptVersion: WECOM_PROMPT_VERSION,
      };
      emit({
        type: "progress",
        phase: "extracting",
        progress: 52 + Math.round((index / Math.max(1, queue.length)) * 38),
        message: "LLM 正在整理增量家校沟通…",
        detail: `${index + 1}/${queue.length} 批 · ${batch.conversationTitle} · ${batch.messageIds.length} 条消息`,
      });
      const operation = await prepareWeComBatch(prisma, batch);
      try {
        if (batch.requiresManualReview) {
          throw new WeComExtractionError(
            "oversized_message",
            "单条消息超过 20000 字符，需要人工复核",
          );
        }
        let candidateJson = operation.candidateJson;
        if (!candidateJson) {
          const generated = await generateWeComBridgeJson(prisma, {
            sourceText: batch.text,
            candidateStudentIds: batch.candidateStudentIds,
            groundedMessages: batch.messages.map((message) => ({ id: message.id, content: message.content })),
          }, {
            onRetry: (reason) => emit({
              type: "progress",
              phase: "extracting",
              progress: 52 + Math.round((index / Math.max(1, queue.length)) * 38),
              message: reason === "network" ? "LLM 网络异常，正在重试一次…" : "LLM 输出未通过 Schema，正在重试一次…",
              detail: `${index + 1}/${queue.length} 批（重试 1/1）`,
            }),
          });
          await refreshWeComAutoImportRun(prisma, claimed.runId);
          await saveWeComBatchDiagnostics(prisma, operation.id, generated.diagnostics);
          const records = objectValue(generated.bridgeJson).records;
          candidateJson = JSON.stringify({
            source: "wecomcatch",
            mode: "candidateOnly",
            records: decorateGroundedWeComRecords(Array.isArray(records) ? records : [], batch),
          });
          await saveWeComBatchCandidate(prisma, operation.id, candidateJson);
        }
        emit({
          type: "progress",
          phase: "importing",
          progress: 90 + Math.round((index / Math.max(1, queue.length)) * 8),
          message: "正在写入增量记录…",
          detail: `${index + 1}/${queue.length} 批`,
        });
        await refreshWeComAutoImportRun(prisma, claimed.runId);
        const result = await applyWeComLedgerBatch(prisma, operation.id, batch, candidateJson);
        attemptedGroundedBatches += 1;
        consecutiveEvidenceFailures = 0;
        mergeResult(totalResult, result);
        if (result.skippedCount > 0) {
          hasAttention = true;
          attentionBatchCount += 1;
        }
      } catch (error) {
        if (error instanceof WeComRunCancelledError) throw error;
        if (error instanceof WeComExtractionError && error.code === "output_truncated") {
          const split = splitWeComExtractionBatch(batch);
          if (split) {
            await markWeComBatchSplit(prisma, operation.id, error);
            queue.splice(index + 1, 0, ...split);
            await prisma.weComImportRun.update({
              where: { id: claimed.runId },
              data: { batchCount: queue.length },
            });
            emit({
              type: "progress",
              phase: "extracting",
              progress: 52 + Math.round((index / Math.max(1, queue.length)) * 38),
              message: "模型输出被截断，已将当前交流段二分…",
              detail: `${batch.messageIds.length} 条消息拆为 ${split[0].messageIds.length} + ${split[1].messageIds.length} 条`,
            });
            continue;
          }
        }
        attemptedGroundedBatches += 1;
        if (error instanceof WeComExtractionError && error.code === "evidence_mismatch") {
          consecutiveEvidenceFailures += 1;
          if (attemptedGroundedBatches <= 20) evidenceFailuresInFirstTwenty += 1;
        } else {
          consecutiveEvidenceFailures = 0;
        }
        const failed = await failWeComBatch(
          prisma,
          operation.id,
          batch.conversationId,
          batch.messageIds,
          error,
          { forceReview: batch.messages.length === 1 && error instanceof WeComExtractionError && error.code === "output_truncated" },
        );
        hasAttention = true;
        attentionBatchCount += 1;
        emit({
          type: "progress",
          phase: "extracting",
          progress: 52 + Math.round(((index + 1) / Math.max(1, queue.length)) * 38),
          message: failed.status === "needs_review" ? "当前交流段已暂停，等待人工处理" : "当前交流段提取失败，已保留重试状态",
          detail: `${index + 1}/${queue.length} 批 · ${failed.message}`,
        });
        if (error instanceof WeComExtractionError && error.code === "protocol_incompatible") throw error;
        if (
          consecutiveEvidenceFailures >= 3
          || (attemptedGroundedBatches <= 20 && evidenceFailuresInFirstTwenty >= 5)
        ) {
          emit({
            type: "progress",
            phase: "extracting",
            progress: 52 + Math.round(((index + 1) / Math.max(1, queue.length)) * 38),
            message: "原文证据连续无法核验，已暂停剩余批次",
            detail: "请检查企微提取模型后手动重新开始；未处理消息仍保持待处理状态",
          });
          break;
        }
      }
    }

    await prisma.$transaction([
      prisma.weComImportRun.update({
        where: { id: claimed.runId },
        data: {
          status: hasAttention || totalResult.skippedCount > 0 ? "attention_required" : "complete",
          conversationCount: conversations.length,
          messageCount,
          batchCount: queue.length,
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
      batchCount: queue.length,
      attentionBatchCount,
      since: claimed.since.toISOString(),
    };
    emit({ type: "progress", phase: "complete", progress: 100, message: "企微增量记录已处理完成" });
    emit(completed);
    return completed;
  } catch (error) {
    if (error instanceof WeComRunCancelledError) {
      await finalizeCancelledRun(prisma, claimed.runId, "cancelled");
      const rolledBack = error.mode === "stop_and_rollback";
      if (rolledBack) await rollbackWeComRun(prisma, claimed.runId);
      const cancelled: WeComAutoImportCancelled = { type: "cancelled", runId: claimed.runId, rolledBack };
      emit(cancelled);
      return cancelled;
    }
    await prisma.weComImportRun.updateMany({
      where: { id: claimed.runId, status: "running" },
      data: { status: "failed", completedAt: new Date() },
    });
    throw error;
  } finally {
    await releaseWeComAutoImportRun(prisma, claimed.runId);
  }
}
