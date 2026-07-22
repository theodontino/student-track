import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDiarizeTask,
  createRetryDiarizeTask,
  findDiarizeResult,
  listDiarizeTasks,
  readDiarizeTask,
  taskToView,
  updateDiarizeTask,
} from "@/lib/diarize-tasks";
import { normalizeHotwordText } from "@/lib/diarize-hotwords";

let tempDir = "";
const originalDataDir = process.env.DIARIZE_DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "student-track-diarize-"));
  process.env.DIARIZE_DATA_DIR = tempDir;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.env.DIARIZE_DATA_DIR = originalDataDir;
});

describe("diarize task files", () => {
  it("normalizes hotwords from legacy and active formats", () => {
    expect(normalizeHotwordText("# comment\n侯氏制碱法|索尔维制碱法\n氯化钠\n侯氏制碱法\n")).toEqual([
      "侯氏制碱法",
      "索尔维制碱法",
      "氯化钠",
    ]);
  });

  it("creates, lists, updates, and reads a task result", async () => {
    const task = await createDiarizeTask({
      engine: "local",
      speakerCount: 2,
      inputFileName: "课堂录音.mp3",
    });
    await fs.promises.writeFile(task.inputPath, "audio");
    await fs.promises.writeFile(path.join(task.outputDir, "input-课堂录音_speakers.txt"), "转写文本");

    const result = await findDiarizeResult(task);
    const updated = await updateDiarizeTask(task.id, {
      status: "succeeded",
      resultTextPath: result.resultTextPath,
    });

    expect(await listDiarizeTasks()).toHaveLength(1);
    expect(await readDiarizeTask(task.id)).toMatchObject({ status: "succeeded", engine: "local" });
    await expect(taskToView(updated, true)).resolves.toMatchObject({
      hasResultText: true,
      resultText: "转写文本",
    });
  });

  it("creates retry task with copied input and parent link", async () => {
    const source = await createDiarizeTask({
      engine: "auto",
      inputFileName: "audio.wav",
    });
    await fs.promises.writeFile(source.inputPath, "audio-bytes");

    const retry = await createRetryDiarizeTask(source);
    await expect(fs.promises.readFile(retry.inputPath, "utf8")).resolves.toBe("audio-bytes");
    expect(retry.retryOf).toBe(source.id);
    expect(retry.engine).toBe("auto");
  });

  it("rebases stored task paths after the data directory moves", async () => {
    const task = await createDiarizeTask({
      engine: "local",
      inputFileName: "课堂录音.wav",
    });
    await fs.promises.writeFile(task.inputPath, "audio-bytes");

    const movedDir = `${tempDir}-moved`;
    await fs.promises.rename(tempDir, movedDir);
    tempDir = movedDir;
    process.env.DIARIZE_DATA_DIR = movedDir;

    const movedTask = await readDiarizeTask(task.id);
    expect(movedTask.outputDir).toBe(path.join(movedDir, "tasks", task.id));
    await expect(fs.promises.readFile(movedTask.inputPath, "utf8")).resolves.toBe("audio-bytes");

    const retry = await createRetryDiarizeTask(movedTask);
    await expect(fs.promises.readFile(retry.inputPath, "utf8")).resolves.toBe("audio-bytes");
  });
});
