import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import type {
  AssessmentKnowledgePoint,
  AssessmentWrongItem,
  StudentAssessmentEvidence,
} from "@/lib/feedback-materials";

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_BYTES = 2 * 1024 * 1024;

export interface PdfTextLayoutItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

interface PositionedPdfTextItem extends PdfTextLayoutItem {
  order: number;
  segment: number;
  x: number;
  y: number;
  lineHeight: number;
}

interface PdfTextLine {
  baseline: number;
  lineHeight: number;
  order: number;
  segment: number;
  items: PositionedPdfTextItem[];
}

class AssessmentPdfExtractionError extends Error {}

export interface ParsedAssessmentPdf {
  reportStudentName: string;
  reportStudentId: string;
  evidence: StudentAssessmentEvidence;
}

function normalizedText(value: string) {
  return value
    .replace(/\u000c/g, "\n")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function localPdfJsAssetDirectory(name: "cmaps" | "iccs" | "standard_fonts" | "wasm") {
  const directory = path.resolve(process.cwd(), "node_modules", "pdfjs-dist", name);
  return `${directory.split(path.sep).join("/")}/`;
}

function configureLocalPdfJsWorker() {
  GlobalWorkerOptions.workerSrc = pathToFileURL(path.resolve(
    process.cwd(),
    "node_modules",
    "pdfjs-dist",
    "legacy",
    "build",
    "pdf.worker.mjs",
  )).href;
}

function coordinate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textItemLineHeight(item: PdfTextLayoutItem) {
  return Math.max(
    Math.abs(coordinate(item.transform[0])),
    Math.abs(coordinate(item.transform[3])),
    Math.abs(coordinate(item.height)),
    1,
  );
}

function estimatedCharacterWidth(item: PositionedPdfTextItem) {
  const characters = [...item.str.trim()].length;
  if (characters > 0 && item.width > 0) return item.width / characters;
  return Math.max(item.lineHeight * 0.5, 1);
}

function needsLayoutSpace(previous: PositionedPdfTextItem, current: PositionedPdfTextItem) {
  if (/\s$/.test(previous.str) || /^\s/.test(current.str)) return false;
  const gap = current.x - (previous.x + Math.max(previous.width, 0));
  if (gap <= 0) return false;
  const characterWidth = Math.max(
    1,
    Math.min(estimatedCharacterWidth(previous), estimatedCharacterWidth(current)),
  );
  const chineseBoundary = /\p{Script=Han}$/u.test(previous.str) && /^\p{Script=Han}/u.test(current.str);
  return gap > characterWidth * (chineseBoundary ? 0.75 : 0.2);
}

function lineText(line: PdfTextLine) {
  const items = [...line.items].sort((left, right) => left.x - right.x || left.order - right.order);
  let result = "";
  let previous: PositionedPdfTextItem | null = null;
  for (const item of items) {
    const value = item.str.replace(/[\r\n]+/g, " ");
    if (!value) continue;
    if (previous && needsLayoutSpace(previous, item)) result += " ";
    result += value;
    previous = item;
  }
  return result.trim();
}

export function layoutPdfTextItems(items: PdfTextLayoutItem[]) {
  const lines: PdfTextLine[] = [];
  let segment = 0;

  items.forEach((item, order) => {
    const positioned: PositionedPdfTextItem = {
      ...item,
      order,
      segment,
      x: coordinate(item.transform[4]),
      y: coordinate(item.transform[5]),
      lineHeight: textItemLineHeight(item),
    };
    if (item.str) {
      const line = lines
        .filter((candidate) => candidate.segment === segment)
        .map((candidate) => ({
          candidate,
          distance: Math.abs(candidate.baseline - positioned.y),
        }))
        .filter(({ candidate, distance }) => (
          distance <= Math.max(1.5, Math.min(candidate.lineHeight, positioned.lineHeight) * 0.45)
        ))
        .sort((left, right) => left.distance - right.distance)[0]?.candidate;

      if (line) {
        line.items.push(positioned);
        line.lineHeight = Math.max(line.lineHeight, positioned.lineHeight);
      } else {
        lines.push({
          baseline: positioned.y,
          lineHeight: positioned.lineHeight,
          order,
          segment,
          items: [positioned],
        });
      }
    }
    if (item.hasEOL) segment += 1;
  });

  const text = lines
    .sort((left, right) => right.baseline - left.baseline || left.order - right.order)
    .map(lineText)
    .filter(Boolean)
    .join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_EXTRACTED_TEXT_BYTES) {
    throw new AssessmentPdfExtractionError("PDF 提取文字过多，已停止解析");
  }
  return text;
}

function readablePdfError(error: unknown) {
  const name = error && typeof error === "object" && "name" in error
    ? String(error.name)
    : "";
  if (name === "PasswordException") {
    return new AssessmentPdfExtractionError("PDF 已加密，当前不支持密码保护的文件");
  }
  return new AssessmentPdfExtractionError("PDF 无法读取，可能格式损坏");
}

function firstMatch(value: string, expressions: RegExp[]) {
  for (const expression of expressions) {
    const match = value.match(expression);
    if (match?.[1]) return match[1].replace(/\s+/g, " ").trim();
  }
  return "";
}

function parseNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKnowledgePoints(text: string): AssessmentKnowledgePoint[] {
  const section = text.match(/知识点分析([\s\S]*?)作答明细/)?.[1] ?? "";
  const result: AssessmentKnowledgePoint[] = [];
  const pattern = /([^\n]+?)\s+共\s*(\d+)\s*小题\s+正确率\s*([\d.]+)%\s+均值\s*([\d.]+)%/g;
  for (const match of section.matchAll(pattern)) {
    const name = match[1].replace(/\s+/g, " ").trim();
    const questionCount = Number(match[2]);
    const correctRate = Number(match[3]);
    const cohortAverageRate = Number(match[4]);
    if (!name || !Number.isFinite(questionCount) || !Number.isFinite(correctRate)) continue;
    result.push({
      name,
      questionCount,
      correctRate,
      cohortAverageRate: Number.isFinite(cohortAverageRate) ? cohortAverageRate : null,
    });
  }
  return result.slice(0, 30);
}

function questionBlocks(text: string) {
  const section = text.match(/作答明细([\s\S]*?)(?:\n专属|\n学员：|$)/)?.[1] ?? "";
  const markers = [...section.matchAll(/^\s*(\d+)\s*$/gm)];
  return markers.slice(0, 100).map((marker, index) => {
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? section.length;
    return { questionNumber: marker[1], body: section.slice(start, end) };
  });
}

function parseWrongItems(text: string): AssessmentWrongItem[] {
  return questionBlocks(text).flatMap(({ questionNumber, body }) => {
    const answerMatch = body.match(/我的答案\s+([^\s]+)\s+正确答案\s+([^\s]+)/);
    if (!answerMatch) return [];
    const studentAnswer = answerMatch[1].trim();
    const correctAnswer = answerMatch[2].trim();
    if (!studentAnswer || !correctAnswer || studentAnswer === correctAnswer) return [];
    const knowledgeLine = body.match(/知识图谱\s+([^\n]+)/)?.[1] ?? "";
    const knowledgePoints = knowledgeLine
      .split(/[、，,]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 8);
    return [{ questionNumber, studentAnswer, correctAnswer, knowledgePoints }];
  });
}

function similarPracticeCount(text: string) {
  const section = text.match(/错题相似题([\s\S]*)/)?.[1] ?? "";
  return [...section.matchAll(/^\s*\d+\s+(?:单选题|多选题|填空题|解答题)/gm)].length;
}

export function parseAssessmentPdfText(text: string, fileName: string): ParsedAssessmentPdf {
  const source = normalizedText(text);
  if (!source.trim() || !/(题集报告|PROBLEM SET REPORT)/.test(source)) {
    throw new Error("未识别到受支持的题集报告文字，请确认 PDF 不是扫描件");
  }

  const reportStudentName = firstMatch(source, [
    /亲爱的\s*([^\s～~]+?)同学/,
    /学员[：:]\s*([^\s|]+)/,
  ]);
  const reportStudentId = firstMatch(source, [
    /\b(SZS[A-Za-z0-9-]+)\b/,
    /\b([A-Z]{2,}\d{6,})\b/,
  ]);
  const reportDateRaw = firstMatch(source, [
    /PROBLEM SET REPORT\s+(\d{4}[/-]\d{2}[/-]\d{2})/,
    /生成时间[：:]\s*(\d{4}[/-]\d{2}[/-]\d{2})/,
  ]);
  const reportDate = reportDateRaw.replace(/\//g, "-");
  const reportTitle = firstMatch(source, [
    /PROBLEM SET REPORT\s+\d{4}[/-]\d{2}[/-]\d{2}\s+([^\n]+)/,
    /(?:^|\n)\s*(\d{2}[^\n]+基础)\s*(?:\n|$)/,
  ]) || fileName.replace(/\.pdf$/i, "").replace(/[（(].*?[）)]/g, "").trim();
  const summary = source.match(/合计完成了\s*(\d+)\s*道小题，正确率为\s*([\d.]+)%，(?:高于|低于|接近)?平均正确率\s*([\d.]+)%/);
  const totalQuestions = parseNumber(summary?.[1]);
  const correctRate = parseNumber(summary?.[2]);
  const cohortAverageRate = parseNumber(summary?.[3]);
  if (totalQuestions === null || correctRate === null) {
    throw new Error("题集报告中未找到总题数或正确率");
  }

  return {
    reportStudentName,
    reportStudentId,
    evidence: {
      reportTitle,
      reportDate,
      totalQuestions,
      correctRate,
      cohortAverageRate,
      knowledgePoints: parseKnowledgePoints(source),
      wrongItems: parseWrongItems(source),
      similarPracticeCount: similarPracticeCount(source),
    },
  };
}

export async function extractPdfText(buffer: ArrayBuffer) {
  if (buffer.byteLength === 0) throw new Error("PDF 文件为空");
  if (buffer.byteLength > MAX_PDF_BYTES) throw new Error("单份 PDF 不能超过 15 MB");
  configureLocalPdfJsWorker();
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: localPdfJsAssetDirectory("cmaps"),
    cMapPacked: true,
    iccUrl: localPdfJsAssetDirectory("iccs"),
    standardFontDataUrl: localPdfJsAssetDirectory("standard_fonts"),
    wasmUrl: localPdfJsAssetDirectory("wasm"),
    useWorkerFetch: false,
    stopAtErrors: true,
    maxImageSize: 0,
    verbosity: 0,
  });

  try {
    const document = await loadingTask.promise;
    const pages: string[] = [];
    let outputBytes = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const pageText = layoutPdfTextItems(content.items.flatMap((item) => (
          "str" in item ? [item as PdfTextLayoutItem] : []
        )));
        outputBytes += Buffer.byteLength(pageText, "utf8") + (pages.length > 0 ? 1 : 0);
        if (outputBytes > MAX_EXTRACTED_TEXT_BYTES) {
          throw new AssessmentPdfExtractionError("PDF 提取文字过多，已停止解析");
        }
        pages.push(pageText);
      } finally {
        page.cleanup();
      }
    }
    const text = pages.join("\n");
    if (!text.trim()) {
      throw new AssessmentPdfExtractionError("PDF 中没有可提取文字，当前版本不支持扫描件");
    }
    return text;
  } catch (error) {
    if (error instanceof AssessmentPdfExtractionError) throw error;
    throw readablePdfError(error);
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

export async function parseAssessmentPdf(buffer: ArrayBuffer, fileName: string) {
  return parseAssessmentPdfText(await extractPdfText(buffer), fileName);
}
