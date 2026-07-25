import { spawn } from "node:child_process";
import type {
  AssessmentKnowledgePoint,
  AssessmentWrongItem,
  StudentAssessmentEvidence,
} from "@/lib/feedback-materials";

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_BYTES = 2 * 1024 * 1024;

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
  const executable = process.env.STUDENT_TRACK_PDFTOTEXT_PATH?.trim() || "pdftotext";

  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ["-layout", "-", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    function fail(error: Error) {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    }

    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        fail(new Error("缺少 pdftotext，本机暂时无法读取出门测 PDF"));
      } else {
        fail(new Error("启动 PDF 文本解析器失败"));
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_EXTRACTED_TEXT_BYTES) {
        fail(new Error("PDF 提取文字过多，已停止解析"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 16_384) stderr.push(chunk);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error("PDF 无法读取，可能是扫描件、加密文件或格式损坏"));
        return;
      }
      const text = Buffer.concat(stdout).toString("utf8");
      if (!text.trim()) {
        reject(new Error("PDF 中没有可提取文字，当前版本不支持扫描件"));
        return;
      }
      resolve(text);
    });
    child.stdin.on("error", () => {
      fail(new Error("向 PDF 解析器传输文件失败"));
    });
    child.stdin.end(Buffer.from(buffer));
  });
}

export async function parseAssessmentPdf(buffer: ArrayBuffer, fileName: string) {
  return parseAssessmentPdfText(await extractPdfText(buffer), fileName);
}
