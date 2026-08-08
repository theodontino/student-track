import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStudentTrackDataPath } from "@/lib/runtime-paths";

export type DiarizeEngine = "auto" | "local" | "tingwu";
export type DiarizeTaskStatus = "queued" | "running" | "succeeded" | "failed";

export interface DiarizeTask {
  id: string;
  title: string;
  engine: DiarizeEngine;
  speakerCount: number | null;
  status: DiarizeTaskStatus;
  inputFileName: string;
  inputPath: string;
  outputDir: string;
  logPath: string;
  resultTextPath: string | null;
  resultJsonPath: string | null;
  retryOf: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DiarizeTaskView {
  id: string;
  title: string;
  engine: DiarizeEngine;
  speakerCount: number | null;
  status: DiarizeTaskStatus;
  inputFileName: string;
  retryOf: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  hasResultText: boolean;
  hasResultJson: boolean;
  resultText?: string;
  log?: string;
}

function readJsonFallbackText(jsonPath: string | null) {
  if (!jsonPath) return "";
  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return "";
    return parsed
      .map((chunk) => typeof chunk?.text === "string" ? chunk.text.trim() : "")
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

export function diarizeDataDir() {
  return resolveStudentTrackDataPath("diarize", "DIARIZE_DATA_DIR");
}

export function diarizeTasksDir() {
  return path.join(diarizeDataDir(), "tasks");
}

export function taskDir(taskId: string) {
  return path.join(diarizeTasksDir(), taskId);
}

function taskPath(taskId: string) {
  return path.join(taskDir(taskId), "task.json");
}

function nowIso() {
  return new Date().toISOString();
}

export function sanitizeFileName(name: string) {
  const cleaned = name.replace(/[\\/:\0]/g, "_").trim();
  return cleaned || "audio";
}

export function isDiarizeEngine(value: unknown): value is DiarizeEngine {
  return value === "auto" || value === "local" || value === "tingwu";
}

export async function createDiarizeTask(input: {
  title?: string;
  engine: DiarizeEngine;
  speakerCount?: number | null;
  inputFileName: string;
  retryOf?: string | null;
}): Promise<DiarizeTask> {
  const id = randomUUID();
  const dir = taskDir(id);
  await fs.promises.mkdir(dir, { recursive: true });

  const inputFileName = sanitizeFileName(input.inputFileName);
  const task: DiarizeTask = {
    id,
    title: input.title?.trim() || inputFileName,
    engine: input.engine,
    speakerCount: input.speakerCount ?? null,
    status: "queued",
    inputFileName,
    inputPath: path.join(dir, `input-${inputFileName}`),
    outputDir: dir,
    logPath: path.join(dir, "stdout.log"),
    resultTextPath: null,
    resultJsonPath: null,
    retryOf: input.retryOf ?? null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
  };
  await writeDiarizeTask(task);
  return task;
}

export async function createRetryDiarizeTask(source: DiarizeTask): Promise<DiarizeTask> {
  const task = await createDiarizeTask({
    title: `${source.title} 重试`,
    engine: source.engine,
    speakerCount: source.speakerCount,
    inputFileName: source.inputFileName,
    retryOf: source.id,
  });
  await fs.promises.copyFile(source.inputPath, task.inputPath);
  return task;
}

export async function writeDiarizeTask(task: DiarizeTask) {
  await fs.promises.mkdir(path.dirname(taskPath(task.id)), { recursive: true });
  await fs.promises.writeFile(taskPath(task.id), JSON.stringify({ ...task, updatedAt: nowIso() }, null, 2));
}

export async function updateDiarizeTask(taskId: string, patch: Partial<DiarizeTask>) {
  const task = await readDiarizeTask(taskId);
  const next = { ...task, ...patch, updatedAt: nowIso() };
  await fs.promises.writeFile(taskPath(taskId), JSON.stringify(next, null, 2));
  return next;
}

export async function readDiarizeTask(taskId: string): Promise<DiarizeTask> {
  const raw = await fs.promises.readFile(taskPath(taskId), "utf8");
  return JSON.parse(raw) as DiarizeTask;
}

export async function listDiarizeTasks(): Promise<DiarizeTask[]> {
  try {
    const entries = await fs.promises.readdir(diarizeTasksDir(), { withFileTypes: true });
    const tasks = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readDiarizeTask(entry.name).catch(() => null)));
    return tasks
      .filter((task): task is DiarizeTask => Boolean(task))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function deleteDiarizeTask(taskId: string) {
  await fs.promises.rm(taskDir(taskId), { recursive: true, force: true });
}

export function appendDiarizeLog(task: DiarizeTask, text: string) {
  fs.mkdirSync(path.dirname(task.logPath), { recursive: true });
  fs.appendFileSync(task.logPath, text);
}

export async function findDiarizeResult(task: DiarizeTask) {
  const entries = await fs.promises.readdir(task.outputDir).catch(() => []);
  const textFile = entries.find((entry) => entry.endsWith("_transcript.txt"))
    ?? entries.find((entry) => entry.endsWith("_speakers.txt"))
    ?? entries.find((entry) => entry.endsWith(".txt"));
  const jsonFile = entries.find((entry) => entry.endsWith("_transcript.json"))
    ?? entries.find((entry) => entry.endsWith("_speakers.json"))
    ?? entries.find((entry) => entry.endsWith(".json") && entry !== "task.json");

  return {
    resultTextPath: textFile ? path.join(task.outputDir, textFile) : null,
    resultJsonPath: jsonFile ? path.join(task.outputDir, jsonFile) : null,
  };
}

export async function taskToView(task: DiarizeTask, includeContent = false): Promise<DiarizeTaskView> {
  const view: DiarizeTaskView = {
    id: task.id,
    title: task.title,
    engine: task.engine,
    speakerCount: task.speakerCount,
    status: task.status,
    inputFileName: task.inputFileName,
    retryOf: task.retryOf,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    hasResultText: Boolean(task.resultTextPath),
    hasResultJson: Boolean(task.resultJsonPath),
  };

  if (includeContent) {
    if (task.resultTextPath) {
      view.resultText = await fs.promises.readFile(task.resultTextPath, "utf8").catch(() => "");
      if (!view.resultText.trim()) {
        view.resultText = readJsonFallbackText(task.resultJsonPath);
      }
    } else {
      view.resultText = readJsonFallbackText(task.resultJsonPath);
    }
    view.log = await fs.promises.readFile(task.logPath, "utf8").catch(() => "");
  }
  return view;
}
