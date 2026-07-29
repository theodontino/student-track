import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiarizeTask } from "./diarize-tasks";
import { prisma } from "./prisma";

export interface DiarizeHotwordFile {
  path: string;
  totalCount: number;
  studentNameCount: number;
}

function defaultToolDir() {
  return process.env.STUDENT_TRACK_DIARIZE_TOOL_DIR
    || process.env.CHEM_TRACK_DIARIZE_TOOL_DIR
    || path.join(os.homedir(), "tools", "funasr-diarize");
}

function defaultBaseHotwordPath() {
  return process.env.STUDENT_TRACK_BASE_HOTWORDS
    || process.env.CHEM_TRACK_BASE_HOTWORDS
    || path.join(defaultToolDir(), "hotwords_active.txt");
}

export function normalizeHotwordText(text: string) {
  const seen = new Set<string>();
  const words: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    for (const part of trimmedLine.split("|")) {
      const word = part.trim();
      if (!word || word.startsWith("#") || seen.has(word)) continue;
      seen.add(word);
      words.push(word);
    }
  }

  return words;
}

async function getStudentNameHotwords() {
  const students = await prisma.student.findMany({
    where: { rosterStatus: "ACTIVE" },
    select: { name: true },
    orderBy: { studentId: "asc" },
  });
  return students.map((student) => student.name.trim()).filter(Boolean);
}

/**
 * Builds a task-local hotword file from base chemistry terms plus current
 * Student names. The file is generated per task so roster changes are picked up
 * on the next transcription without adding persistent schema state.
 */
export async function buildDiarizeHotwordFile(task: DiarizeTask): Promise<DiarizeHotwordFile> {
  const baseText = await fs.promises.readFile(defaultBaseHotwordPath(), "utf8").catch(() => "");
  const studentNames = await getStudentNameHotwords();

  const seen = new Set<string>();
  const hotwords: string[] = [];
  for (const word of [...normalizeHotwordText(baseText), ...studentNames]) {
    const trimmed = word.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    hotwords.push(trimmed);
  }

  const hotwordPath = path.join(task.outputDir, "hotwords.txt");
  await fs.promises.mkdir(task.outputDir, { recursive: true });
  await fs.promises.writeFile(hotwordPath, hotwords.join("\n") + (hotwords.length ? "\n" : ""), "utf8");

  return {
    path: hotwordPath,
    totalCount: hotwords.length,
    studentNameCount: new Set(studentNames).size,
  };
}
