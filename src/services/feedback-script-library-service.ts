import * as XLSX from "xlsx";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { parseLessonFeedbackMaterial, type LessonFeedbackMaterial } from "@/lib/feedback-materials";
import type {
  FeedbackScriptEntry,
  FeedbackScriptLibrary,
  FeedbackScriptLibraryResponse,
} from "@/lib/feedback-script-library";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 100;
const MAX_CELL_LENGTH = 20_000;
const MAX_TOTAL_TEXT_LENGTH = 500_000;

interface ParsedFeedbackScriptLibrary {
  version: 1 | 2;
  name: string;
  entries: FeedbackScriptEntry[];
  warnings: string[];
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeHeader(value: unknown) {
  return clean(value).replace(/[\s：:]/g, "");
}

function columnName(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function findHeaderIndex(headers: string[], candidates: string[]) {
  return headers.findIndex((header) => candidates.includes(header));
}

function parseLessonNumber(value: unknown) {
  const match = clean(value).match(/(?:第\s*)?(\d{1,3})(?:\s*(?:节|课|次))?/);
  return match ? Number(match[1]) : null;
}

function safeCell(value: unknown, label: string) {
  const text = clean(value);
  if (text.length > MAX_CELL_LENGTH) throw new Error(`${label}内容过长，请精简后重试`);
  return text;
}

function removeRenewalPlaceholder(value: string, lessonNumber: number, warnings: string[]) {
  if (!/续班话术/.test(value)) return value;
  warnings.push(`第 ${lessonNumber} 课引用了“续班话术”，本次未导入该私反馈占位内容。`);
  return "";
}

export function parseFeedbackScriptWorkbook(buffer: ArrayBuffer): ParsedFeedbackScriptLibrary {
  if (buffer.byteLength === 0) throw new Error("上传文件为空");
  if (buffer.byteLength > MAX_FILE_BYTES) throw new Error("话术库文件不能超过 5MB");

  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  let selected: { rows: unknown[][]; headerRowIndex: number } | null = null;

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      header: 1,
      defval: "",
      raw: false,
    });
    const headerRowIndex = rows.slice(0, 10).findIndex((row) => {
      const headers = row.map(normalizeHeader);
      return headers.some((header) => ["课次", "课次/进度", "进度"].includes(header))
        && headers.includes("群反馈");
    });
    if (headerRowIndex >= 0) {
      selected = { rows, headerRowIndex };
      break;
    }
  }

  if (!selected) throw new Error("未找到包含“课次”和“群反馈”的表头");
  const { rows, headerRowIndex } = selected;
  const headers = (rows[headerRowIndex] ?? []).map(normalizeHeader);
  const lessonIndex = findHeaderIndex(headers, ["课次", "课次/进度", "进度"]);
  const topicIndex = findHeaderIndex(headers, ["教研内容", "课程内容", "课题", "主题"]);
  const groupIndex = findHeaderIndex(headers, ["群反馈"]);
  const assessmentIndex = findHeaderIndex(headers, ["统一测评说明", "统一出门测说明", "出门测统一说明", "测评说明"]);
  const perfectIndex = findHeaderIndex(headers, ["全对的私反馈", "全对私反馈"]);
  const errorIndex = findHeaderIndex(headers, ["有错误的私反馈", "有错的私反馈", "错误私反馈"]);
  const noteIndex = findHeaderIndex(headers, ["备注"]);

  if (lessonIndex < 0 || groupIndex < 0 || perfectIndex < 0 || errorIndex < 0) {
    throw new Error("表头需包含：课次、群反馈、全对的私反馈、有错误的私反馈");
  }

  const knownIndexes = new Set([
    lessonIndex,
    topicIndex,
    groupIndex,
    assessmentIndex,
    perfectIndex,
    errorIndex,
    noteIndex,
    findHeaderIndex(headers, ["主备人"]),
  ].filter((index) => index >= 0));
  const warnings: string[] = [];
  const maxColumns = Math.max(headers.length, ...rows.slice(headerRowIndex + 1).map((row) => row.length));
  for (let index = 0; index < maxColumns; index++) {
    if (knownIndexes.has(index)) continue;
    if (rows.slice(headerRowIndex + 1).some((row) => clean(row[index]))) {
      const label = headers[index] || `未命名列 ${columnName(index)}`;
      warnings.push(`${label}含有内容，但不是支持的话术列，已跳过。`);
    }
  }

  const entries: FeedbackScriptEntry[] = [];
  const seenLessons = new Set<number>();
  let totalTextLength = 0;
  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] ?? [];
    const lessonRaw = clean(row[lessonIndex]);
    if (!lessonRaw && !row.some((value) => clean(value))) continue;
    const lessonNumber = parseLessonNumber(lessonRaw);
    if (lessonNumber === null || lessonNumber <= 0) {
      warnings.push(`第 ${rowIndex + 1} 行课次无法识别，已跳过。`);
      continue;
    }
    if (seenLessons.has(lessonNumber)) throw new Error(`第 ${lessonNumber} 课重复，请合并后重试`);
    seenLessons.add(lessonNumber);

    const topic = topicIndex >= 0 ? safeCell(row[topicIndex], `第 ${lessonNumber} 课教研内容`) : "";
    const groupFeedback = safeCell(row[groupIndex], `第 ${lessonNumber} 课群反馈`);
    const assessmentBrief = assessmentIndex >= 0 ? safeCell(row[assessmentIndex], `第 ${lessonNumber} 课统一测评说明`) : "";
    const perfectPrivateFeedback = removeRenewalPlaceholder(
      safeCell(row[perfectIndex], `第 ${lessonNumber} 课全对私反馈`),
      lessonNumber,
      warnings,
    );
    const errorPrivateFeedback = removeRenewalPlaceholder(
      safeCell(row[errorIndex], `第 ${lessonNumber} 课有错误私反馈`),
      lessonNumber,
      warnings,
    );
    const note = noteIndex >= 0 ? safeCell(row[noteIndex], `第 ${lessonNumber} 课备注`) : "";
    totalTextLength += topic.length + groupFeedback.length + assessmentBrief.length + perfectPrivateFeedback.length + errorPrivateFeedback.length + note.length;
    if (totalTextLength > MAX_TOTAL_TEXT_LENGTH) throw new Error("话术库文字总量过大，请拆分或精简后重试");
    const parsedMaterial = parseLessonFeedbackMaterial(groupFeedback, assessmentBrief);
    entries.push({
      lessonNumber,
      topic,
      groupFeedback,
      perfectPrivateFeedback,
      errorPrivateFeedback,
      note,
      material: {
        ...parsedMaterial,
        lessonTitle: parsedMaterial.lessonTitle || topic,
        scriptLessonNumber: lessonNumber,
        perfectPrivateTemplate: perfectPrivateFeedback || undefined,
        errorPrivateTemplate: errorPrivateFeedback || undefined,
      },
    });
    if (entries.length > MAX_ENTRIES) throw new Error(`话术库最多支持 ${MAX_ENTRIES} 个课次`);
  }

  if (entries.length === 0) throw new Error("没有识别到可导入的课次");
  entries.sort((left, right) => left.lessonNumber - right.lessonNumber);
  const title = rows.slice(0, headerRowIndex)
    .flatMap((row) => row.map(clean))
    .find(Boolean);
  return {
    version: 2,
    name: title?.slice(0, 200) || "学期话术库",
    entries,
    warnings: [...new Set(warnings)],
  };
}

function materialFromEntry(entry: FeedbackScriptEntry, updatedAt: string): LessonFeedbackMaterial {
  const parsed = entry.material && entry.material.version === 1
    ? entry.material
    : parseLessonFeedbackMaterial(entry.groupFeedback, "");
  return {
    ...parsed,
    lessonTitle: parsed.lessonTitle || entry.topic,
    scriptLessonNumber: entry.lessonNumber,
    perfectPrivateTemplate: parsed.perfectPrivateTemplate ?? (entry.perfectPrivateFeedback || undefined),
    errorPrivateTemplate: parsed.errorPrivateTemplate ?? (entry.errorPrivateFeedback || undefined),
    semesterScriptSource: { lessonNumber: entry.lessonNumber, libraryUpdatedAt: updatedAt },
  };
}

function normalizeLibrary(
  parsed: { version?: number; name?: string; entries?: FeedbackScriptEntry[]; warnings?: string[] },
  updatedAt: string,
): FeedbackScriptLibrary {
  const entries = Array.isArray(parsed.entries) ? parsed.entries.map((entry) => ({
    lessonNumber: entry.lessonNumber,
    topic: entry.topic ?? "",
    groupFeedback: entry.groupFeedback ?? "",
    perfectPrivateFeedback: entry.perfectPrivateFeedback ?? "",
    errorPrivateFeedback: entry.errorPrivateFeedback ?? "",
    note: entry.note ?? "",
    material: materialFromEntry(entry, updatedAt),
  })) : [];
  if (!entries.length) throw new Error("已保存的话术库格式无效，请重新上传");
  return {
    version: 2,
    name: parsed.name || "学期公共材料库",
    entries,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    updatedAt,
  };
}

function parseStoredLibrary(semester: {
  feedbackScriptLibraryName: string | null;
  feedbackScriptLibraryJson: string | null;
  feedbackScriptLibraryUpdatedAt: Date | null;
}): FeedbackScriptLibrary | null {
  if (!semester.feedbackScriptLibraryJson || !semester.feedbackScriptLibraryUpdatedAt) return null;
  const parsed = JSON.parse(semester.feedbackScriptLibraryJson) as ParsedFeedbackScriptLibrary;
  if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.entries)) throw new Error("已保存的话术库格式无效，请重新上传");
  const normalized = normalizeLibrary(parsed, semester.feedbackScriptLibraryUpdatedAt.toISOString());
  return { ...normalized, name: semester.feedbackScriptLibraryName || normalized.name };
}

async function recommendedLessonNumber(prisma: PrismaClient | Prisma.TransactionClient, semesterId: string, sessionCode?: string) {
  if (!sessionCode) return null;
  const session = await prisma.classSession.findUnique({
    where: { code: sessionCode },
    select: { semesterId: true, semesterNumber: true, groupLessonSession: { select: { groupLesson: { select: { sequence: true } } } } },
  });
  return session?.semesterId === semesterId
    ? session.groupLessonSession?.groupLesson.sequence ?? session.semesterNumber
    : null;
}

export async function getFeedbackScriptLibrary(
  prisma: PrismaClient | Prisma.TransactionClient,
  semesterId: string,
  sessionCode?: string,
): Promise<FeedbackScriptLibraryResponse> {
  const semester = await prisma.semester.findUnique({
    where: { id: semesterId },
    select: {
      feedbackScriptLibraryName: true,
      feedbackScriptLibraryJson: true,
      feedbackScriptLibraryUpdatedAt: true,
    },
  });
  if (!semester) throw new Error("学期不存在");
  return {
    library: parseStoredLibrary(semester),
    recommendedLessonNumber: await recommendedLessonNumber(prisma, semesterId, sessionCode),
  };
}

export async function saveFeedbackScriptLibrary(
  prisma: PrismaClient,
  semesterId: string,
  buffer: ArrayBuffer,
  sessionCode?: string,
): Promise<FeedbackScriptLibraryResponse> {
  const parsed = parseFeedbackScriptWorkbook(buffer);
  const existing = await prisma.semester.findUnique({ where: { id: semesterId }, select: { id: true } });
  if (!existing) throw new Error("学期不存在");
  const updatedAt = new Date();
  const normalized = normalizeLibrary(parsed, updatedAt.toISOString());
  const updated = await prisma.semester.update({
    where: { id: semesterId },
    data: {
      feedbackScriptLibraryName: parsed.name,
      feedbackScriptLibraryJson: JSON.stringify({
        version: normalized.version,
        name: normalized.name,
        entries: normalized.entries,
        warnings: normalized.warnings,
      }),
      feedbackScriptLibraryUpdatedAt: updatedAt,
    },
    select: {
      feedbackScriptLibraryName: true,
      feedbackScriptLibraryJson: true,
      feedbackScriptLibraryUpdatedAt: true,
    },
  });
  return {
    library: parseStoredLibrary(updated),
    recommendedLessonNumber: await recommendedLessonNumber(prisma, semesterId, sessionCode),
  };
}

export async function getFeedbackScriptMaterial(
  db: PrismaClient | Prisma.TransactionClient,
  semesterId: string,
  lessonNumber: number,
) {
  const response = await getFeedbackScriptLibrary(db, semesterId);
  const entry = response.library?.entries.find((item) => item.lessonNumber === lessonNumber);
  return entry?.material ?? null;
}
