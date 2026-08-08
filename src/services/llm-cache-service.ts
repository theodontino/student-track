import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { resolveStudentTrackDataPath } from "@/lib/runtime-paths";

export type LLMTaskType = "wecom" | "classroom-parse" | "feedback" | "daily-report";
export type LLMCacheStatus = "active" | "succeeded" | "failed" | "interrupted";

interface LLMCacheManifest {
  id: string;
  taskType: LLMTaskType;
  title: string;
  status: LLMCacheStatus;
  startedAt: string;
  completedAt: string | null;
  callCount: number;
  warning: string | null;
}

interface LLMCacheContext {
  directory: string;
  manifest: LLMCacheManifest;
  nextCall: number;
  pendingWrites: Set<Promise<void>>;
  cacheWarning: boolean;
  incomplete: boolean;
  replayIndex: Map<string, string>;
}

export interface LLMCacheSummary extends LLMCacheManifest {
  sizeBytes: number;
}

export interface LLMCacheOverview {
  rootLabel: string;
  totalSizeBytes: number;
  maxSizeBytes: number;
  operations: LLMCacheSummary[];
}

export interface LLMCacheReplayHit {
  response: Response;
  source: { directory: string; callNumber: string; startedAt: string; taskType: LLMTaskType };
}

const DEFAULT_CACHE_LIMIT_BYTES = 256 * 1024 * 1024;
const manifestName = "manifest.json";
const replayIndexName = "replay-index.json";
const storage = new AsyncLocalStorage<LLMCacheContext>();
const activeDirectories = new Set<string>();

function cacheRoot() {
  return resolveStudentTrackDataPath("llm-cache", "LLM_CACHE_ROOT");
}

function cacheLimitBytes() {
  const configured = Number(process.env.LLM_CACHE_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CACHE_LIMIT_BYTES;
}

function replayEnabled() {
  const configured = process.env.LLM_CACHE_REPLAY;
  return /^(1|true|on|enabled)$/i.test(configured || "");
}

// 复用的"指纹"：同模型 + 同消息 + 同参数 + 同响应格式，认定可以安全复用历史响应。
function computeReplayKey(payload: unknown): string {
  let canonical: string;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    // 只有完整请求完全一致才可复用。简化 schema/reasoning 等字段会让“重新生成”
    // 或协议降级错误地命中旧响应。
    canonical = stableStringify(record);
  } else {
    canonical = stableStringify(payload ?? null);
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// 对任意 JSON 值生成稳定字符串：对象 key 按字典序排序，数组保持原顺序。
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)$/i.test(key)) {
      return [key, "[REDACTED]"];
    }
    return [key, sanitize(item)];
  }));
}

async function ensurePrivateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
}

async function writePrivateJson(filePath: string, value: unknown) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(sanitize(value), null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
}

async function readManifest(directory: string): Promise<LLMCacheManifest | null> {
  try {
    return JSON.parse(await readFile(path.join(directory, manifestName), "utf8")) as LLMCacheManifest;
  } catch {
    return null;
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else total += (await stat(target).catch(() => null))?.size ?? 0;
  }
  return total;
}

async function operationDirectories() {
  const root = cacheRoot();
  const results: string[] = [];
  for (const day of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!day.isDirectory()) continue;
    const dayDirectory = path.join(root, day.name);
    for (const task of await readdir(dayDirectory, { withFileTypes: true }).catch(() => [])) {
      if (!task.isDirectory()) continue;
      const taskDirectory = path.join(dayDirectory, task.name);
      for (const operation of await readdir(taskDirectory, { withFileTypes: true }).catch(() => [])) {
        if (operation.isDirectory()) results.push(path.join(taskDirectory, operation.name));
      }
    }
  }
  return results;
}

async function markInterruptedOperations() {
  for (const directory of await operationDirectories()) {
    if (activeDirectories.has(directory)) continue;
    const manifest = await readManifest(directory);
    if (manifest?.status !== "active") continue;
    await writePrivateJson(path.join(directory, manifestName), {
      ...manifest,
      status: "interrupted",
      completedAt: new Date().toISOString(),
      warning: "上次运行在进程结束前未完成",
    }).catch(() => undefined);
  }
}

async function purgeOldDays() {
  const root = cacheRoot();
  const today = shanghaiDate();
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === today) continue;
    const directory = path.join(root, entry.name);
    const containsActive = [...activeDirectories].some((active) => active.startsWith(`${directory}${path.sep}`));
    if (!containsActive) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function enforceCapacity() {
  const operations = await Promise.all((await operationDirectories()).map(async (directory) => ({
    directory,
    manifest: await readManifest(directory),
    sizeBytes: await directorySize(directory),
  })));
  let total = operations.reduce((sum, operation) => sum + operation.sizeBytes, 0);
  const limit = cacheLimitBytes();
  if (total <= limit) return;
  const removable = operations
    .filter((operation) => !activeDirectories.has(operation.directory) && operation.manifest?.status !== "active")
    .sort((left, right) => {
      const leftFailure = ["failed", "interrupted"].includes(left.manifest?.status || "") ? 0 : 1;
      const rightFailure = ["failed", "interrupted"].includes(right.manifest?.status || "") ? 0 : 1;
      return leftFailure - rightFailure
        || String(left.manifest?.startedAt || "").localeCompare(String(right.manifest?.startedAt || ""));
    });
  for (const operation of removable) {
    if (total <= limit) break;
    await rm(operation.directory, { recursive: true, force: true }).catch(() => undefined);
    total -= operation.sizeBytes;
  }
}

async function prepareCacheArea() {
  await ensurePrivateDirectory(cacheRoot());
  await markInterruptedOperations();
  await purgeOldDays();
  await enforceCapacity();
}

async function clearOlderSuccessfulGeneration(current: LLMCacheContext) {
  // 当前操作一旦成功完成，它自己就是同任务类型下"最新一次成功"。
  // 把其它更早的成功操作清掉，给后续批次留一份干净的可复用基线。
  // 失败 / 中断的同类型操作不删（它们对排障仍然有用）。
  for (const directory of await operationDirectories()) {
    if (directory === current.directory || activeDirectories.has(directory)) continue;
    const manifest = await readManifest(directory);
    if (manifest?.taskType !== current.manifest.taskType) continue;
    if (manifest.status !== "succeeded") continue;
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function addPending(context: LLMCacheContext, promise: Promise<void>) {
  context.pendingWrites.add(promise);
  void promise.finally(() => context.pendingWrites.delete(promise)).catch(() => undefined);
}

async function writeForContext(context: LLMCacheContext, filePath: string, value: unknown) {
  try {
    await writePrivateJson(filePath, value);
  } catch {
    context.cacheWarning = true;
  }
}

async function writeReplayIndex(context: LLMCacheContext) {
  if (context.replayIndex.size === 0) return;
  const entries: Record<string, { callNumber: string; capturedAt: string }> = {};
  const capturedAt = new Date().toISOString();
  for (const [key, callNumber] of context.replayIndex) {
    entries[key] = { callNumber, capturedAt };
  }
  await writePrivateJson(path.join(context.directory, replayIndexName), {
    version: 1,
    taskType: context.manifest.taskType,
    entries,
  });
}

async function findReplayResponse(
  taskType: LLMTaskType,
  replayKey: string,
  currentDirectory: string,
): Promise<LLMCacheReplayHit | null> {
  // 在"同任务类型、非当前/活跃目录"里挑最近一次仍然有索引的（成功或中断都算，只要那次调用的响应完整）。
  const candidates: Array<{ directory: string; startedAt: string; indexPath: string }> = [];
  for (const directory of await operationDirectories()) {
    if (directory === currentDirectory || activeDirectories.has(directory)) continue;
    const manifest = await readManifest(directory);
    if (manifest?.taskType !== taskType) continue;
    candidates.push({ directory, startedAt: manifest.startedAt, indexPath: path.join(directory, replayIndexName) });
  }
  candidates.sort((left, right) => right.startedAt.localeCompare(left.startedAt));

  for (const candidate of candidates) {
    const indexRaw = await readFile(candidate.indexPath, "utf8").catch(() => null);
    if (!indexRaw) continue;
    let index: { entries?: Record<string, { callNumber: string }> };
    try { index = JSON.parse(indexRaw) as typeof index; } catch { continue; }
    const entry = index.entries?.[replayKey];
    if (!entry) continue;
    const responsePath = path.join(candidate.directory, "calls", entry.callNumber, "response.json");
    const responseRaw = await readFile(responsePath, "utf8").catch(() => null);
    if (!responseRaw) continue;
    let responseFile: { status?: number; content?: string; reasoningContent?: string; finishReason?: string | null; usage?: unknown };
    try { responseFile = JSON.parse(responseRaw) as typeof responseFile; } catch { continue; }
    if (responseFile.status && responseFile.status >= 400) continue;
    if (typeof responseFile.content !== "string") continue;
    const message: Record<string, unknown> = { content: responseFile.content };
    if (responseFile.reasoningContent) message.reasoning_content = responseFile.reasoningContent;
    const body = JSON.stringify({
      choices: [{ finish_reason: responseFile.finishReason ?? "stop", message }],
      ...(responseFile.usage ? { usage: responseFile.usage } : {}),
    });
    return {
      response: new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-LLM-Cache-Replay": "1",
          "X-LLM-Cache-Source": path.basename(path.dirname(path.dirname(candidate.directory))),
        },
      }),
      source: {
        directory: candidate.directory,
        callNumber: entry.callNumber,
        startedAt: candidate.startedAt,
        taskType,
      },
    };
  }
  return null;
}

async function completeOperation(context: LLMCacheContext, status: "succeeded" | "failed") {
  await Promise.allSettled([...context.pendingWrites]);
  context.manifest = {
    ...context.manifest,
    status: context.incomplete ? "failed" : status,
    completedAt: new Date().toISOString(),
    warning: context.cacheWarning
      ? "部分缓存文件写入失败，业务结果不受影响"
      : context.incomplete ? "任务包含待人工处理结果，缓存已保留" : null,
  };
  await writePrivateJson(path.join(context.directory, manifestName), context.manifest).catch(() => undefined);
  // 把内存中的 replay 索引落盘，给后续批次复用。
  await writeReplayIndex(context).catch(() => undefined);
  activeDirectories.delete(context.directory);
  if (status === "succeeded" && !context.incomplete) await clearOlderSuccessfulGeneration(context);
  await enforceCapacity();
}

export async function withLLMCacheOperation<T>(
  taskType: LLMTaskType,
  title: string,
  callback: () => Promise<T>,
): Promise<T> {
  await prepareCacheArea().catch(() => undefined);
  const id = randomUUID();
  const directory = path.join(cacheRoot(), shanghaiDate(), taskType, id);
  const context: LLMCacheContext = {
    directory,
    manifest: {
      id,
      taskType,
      title,
      status: "active",
      startedAt: new Date().toISOString(),
      completedAt: null,
      callCount: 0,
      warning: null,
    },
    nextCall: 1,
    pendingWrites: new Set(),
    cacheWarning: false,
    incomplete: false,
    replayIndex: new Map(),
  };
  activeDirectories.add(directory);
  await writeForContext(context, path.join(directory, manifestName), context.manifest);
  try {
    const result = await storage.run(context, callback);
    await completeOperation(context, "succeeded");
    return result;
  } catch (error) {
    await completeOperation(context, "failed");
    throw error;
  }
}

export function markCurrentLLMCacheOperationIncomplete() {
  const context = storage.getStore();
  if (context) context.incomplete = true;
}

function parseResponseBody(body: string) {
  try {
    const payload = JSON.parse(body) as Record<string, any>;
    const choice = payload.choices?.[0] ?? {};
    const message = choice.message ?? {};
    return {
      model: payload.model,
      content: message.content ?? "",
      reasoningContent: message.reasoning_content ?? message.reasoning ?? "",
      finishReason: choice.finish_reason ?? null,
      usage: payload.usage ?? null,
    };
  } catch {
    return { content: body, reasoningContent: "", finishReason: null, usage: null };
  }
}

function parseStreamBody(body: string) {
  let content = "";
  let reasoningContent = "";
  let finishReason: string | null = null;
  let usage: unknown = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data) as Record<string, any>;
      const choice = payload.choices?.[0] ?? {};
      content += choice.delta?.content ?? "";
      reasoningContent += choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? "";
      finishReason = choice.finish_reason ?? finishReason;
      usage = payload.usage ?? usage;
    } catch {
      // Preserve the useful reconstructed output even if a provider emits a non-JSON SSE line.
    }
  }
  return { content, reasoningContent, finishReason, usage };
}

async function readBody(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

export async function llmCacheFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  role = "default",
): Promise<Response> {
  const context = storage.getStore();
  if (!context) return fetch(input, init);

  const callNumber = context.nextCall++;
  context.manifest.callCount = callNumber;
  const callDirectory = path.join(context.directory, "calls", String(callNumber).padStart(3, "0"));
  let requestPayload: unknown = null;
  if (typeof init?.body === "string") {
    try { requestPayload = JSON.parse(init.body); }
    catch { requestPayload = { body: init.body }; }
  }
  const replayKey = computeReplayKey(requestPayload);
  await writeForContext(context, path.join(callDirectory, "request.json"), {
    createdAt: new Date().toISOString(),
    role,
    replayKey,
    request: requestPayload,
  });
  await writeForContext(context, path.join(context.directory, manifestName), context.manifest);

  // 命中历史缓存就直接复用，避免再次付费调用 LLM；
  // 流式响应暂时不参与复用（实现复杂，且现有场景里很少出现）。
  if (replayEnabled() && !isStreamingRequest(requestPayload)) {
    try {
      const replay = await findReplayResponse(context.manifest.taskType, replayKey, context.directory);
      if (replay) {
        const snapshot = await snapshotReplayResponse(replay.response.clone());
        await writeForContext(context, path.join(callDirectory, "replay.json"), {
          replayedAt: new Date().toISOString(),
          source: {
            directory: replay.source.directory,
            callNumber: replay.source.callNumber,
            startedAt: replay.source.startedAt,
            taskType: replay.source.taskType,
          },
          // 把复用到的正文也留底，便于排障 / 复现。
          responseSnapshot: snapshot,
        });
        await writeForContext(context, path.join(callDirectory, "response.json"), {
          completedAt: new Date().toISOString(),
          ...parseResponseBody(snapshot.body),
          status: snapshot.status,
        });
        context.replayIndex.set(replayKey, String(callNumber).padStart(3, "0"));
        return replay.response;
      }
    } catch {
      // 复用失败不影响主流程，继续走真实 LLM 请求。
    }
  }

  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    await writeForContext(context, path.join(callDirectory, "error.json"), {
      failedAt: new Date().toISOString(),
      type: error instanceof Error ? error.name : "NetworkError",
      message: "网络请求未获得响应",
    });
    throw error;
  }

  if (!response.body) {
    await writeForContext(context, path.join(callDirectory, response.ok ? "response.json" : "error.json"), {
      completedAt: new Date().toISOString(),
      status: response.status,
      finishReason: null,
    });
    return response;
  }
  const [clientBody, cacheBody] = response.body.tee();
  const cachedResponse = new Response(clientBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const cacheWrite = readBody(cacheBody).then(async (body) => {
    if (!response.ok) {
      let providerError: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(body) as Record<string, any>;
        providerError = {
          type: parsed.error?.type,
          code: parsed.error?.code,
          param: parsed.error?.param,
          message: "模型服务返回错误",
        };
      } catch {
        providerError = { message: `HTTP ${response.status}` };
      }
      await writeForContext(context, path.join(callDirectory, "error.json"), {
        failedAt: new Date().toISOString(),
        status: response.status,
        ...providerError,
      });
      return;
    }
    const request = requestPayload && typeof requestPayload === "object" ? requestPayload as Record<string, unknown> : {};
    const parsed = request.stream === true ? parseStreamBody(body) : parseResponseBody(body);
    await writeForContext(context, path.join(callDirectory, "response.json"), {
      completedAt: new Date().toISOString(),
      status: response.status,
      ...parsed,
    });
    // 只把"非流式 + 成功 + 有正文"的响应纳入复用索引。
    if (request.stream !== true && parsed.content) {
      context.replayIndex.set(replayKey, String(callNumber).padStart(3, "0"));
    }
  }).catch(() => { context.cacheWarning = true; });
  addPending(context, cacheWrite);
  return cachedResponse;
}

function isStreamingRequest(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as Record<string, unknown>).stream === true;
}

async function snapshotReplayResponse(response: Response): Promise<{ status: number; body: string }> {
  try {
    const body = await response.text();
    return { status: response.status, body };
  } catch {
    return { status: response.status, body: "" };
  }
}

export async function getLLMCacheOverview(): Promise<LLMCacheOverview> {
  await prepareCacheArea().catch(() => undefined);
  const operations = (await Promise.all((await operationDirectories()).map(async (directory) => {
    const manifest = await readManifest(directory);
    if (!manifest) return null;
    return { ...manifest, sizeBytes: await directorySize(directory) } satisfies LLMCacheSummary;
  }))).filter((value): value is LLMCacheSummary => value !== null)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return {
    rootLabel: "data/llm-cache",
    totalSizeBytes: operations.reduce((sum, operation) => sum + operation.sizeBytes, 0),
    maxSizeBytes: cacheLimitBytes(),
    operations,
  };
}

export async function clearLLMCache(taskType?: LLMTaskType) {
  await markInterruptedOperations();
  let removed = 0;
  for (const directory of await operationDirectories()) {
    if (activeDirectories.has(directory)) continue;
    const manifest = await readManifest(directory);
    if (!manifest || (taskType && manifest.taskType !== taskType)) continue;
    await rm(directory, { recursive: true, force: true });
    removed += 1;
  }
  return { removed };
}
