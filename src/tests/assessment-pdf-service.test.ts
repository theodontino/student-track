import { describe, expect, it } from "vitest";
import {
  extractPdfText,
  layoutPdfTextItems,
  parseAssessmentPdfText,
  type PdfTextLayoutItem,
} from "@/services/assessment-pdf-service";

const encryptedSyntheticPdf = "JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGQ1MTZlOTU0YzA+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8YTgxN2MwMzIxY2ViOTJjMDQ3MDkyMDc2MTA0NjJkZjViZWIwMzJjYzBhYTQ4YTY3MGY5YWVmNTM3NTk2MzdkNj4KL1UgPDIyOWI4ZWJjYTUzMTFkZWYzZjhiNzM4MzQ1MzExZTdmMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM1Mzk2MzMyMzA2MjYyNjE2NTYzMzgzMjY1MzE2MjM1NjMzNjMzNjM2MTYyNjU2NjM1NjE2NjYxNjU2NjMxMzE+IDwzNTM5NjMzMjMwNjI2MjYxNjU2MzM4MzI2NTMxNjIzNTYzMzYzMzYzNjE2MjY1NjYzNTYxNjY2MTY1NjYzMTMxPiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK";

function pdfText(value: string) {
  return value.replace(/([\\()])/g, "\\$1");
}

function assemblePdf(objects: string[]) {
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}

function syntheticPdf(lines: string[]) {
  const commands = ["BT", "/F1 12 Tf", "72 720 Td"];
  lines.forEach((line, index) => {
    if (index > 0) commands.push("0 -18 Td");
    commands.push(`(${pdfText(line)}) Tj`);
  });
  commands.push("ET");
  const stream = commands.join("\n");
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

function syntheticChinesePdf() {
  const stream = "BT\n/F1 12 Tf\n72 720 Td\n<989896C662A5544A> Tj\nET";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>",
  ]);
}

function arrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function layoutItem(
  str: string,
  x: number,
  y: number,
  width: number,
  hasEOL = false,
): PdfTextLayoutItem {
  return { str, transform: [10, 0, 0, 10, x, y], width, height: 10, hasEOL };
}

const syntheticReport = `题集报告
PROBLEM SET REPORT 2099/07/13

04示例基础
张三 TEST20260001

HI～亲爱的张三同学～
你合计完成了5道小题，正确率为80%，高于平均正确率72.2%。

知识点分析
示例概念辨析 共4小题 正确率100.0% 均值82.3%
示例分类判断 共1小题 正确率0.0% 均值31.7%

作答明细
 1
示例题目
    我的答案
 D
    正确答案
 A
    解析
 示例解析
    知识图谱
 示例分类判断

专属
学员：张三 教师：王老师 生成时间：2099-07-13

张三的化学错题相似题
 1 单选题
示例相似题
`;

describe("assessment PDF parser", () => {
  it("extracts identity, summary, weak knowledge points and wrong answers", () => {
    const parsed = parseAssessmentPdfText(syntheticReport, "04示例报告（张三）.pdf");
    expect(parsed.reportStudentName).toBe("张三");
    expect(parsed.evidence).toMatchObject({
      reportTitle: "04示例基础",
      reportDate: "2099-07-13",
      totalQuestions: 5,
      correctRate: 80,
      cohortAverageRate: 72.2,
      similarPracticeCount: 1,
    });
    expect(parsed.evidence.knowledgePoints).toHaveLength(2);
    expect(parsed.evidence.wrongItems).toEqual([{
      questionNumber: "1",
      studentAnswer: "D",
      correctAnswer: "A",
      knowledgePoints: ["示例分类判断"],
    }]);
  });

  it("rejects image-only or unrelated text", () => {
    expect(() => parseAssessmentPdfText("只有图片，没有题集文字", "scan.pdf"))
      .toThrow("未识别到受支持的题集报告文字");
  });
});

describe("PDF.js text extraction", () => {
  it("reconstructs Chinese runs, English spaces and line boundaries", () => {
    const text = layoutPdfTextItems([
      layoutItem("题集", 10, 700, 20),
      layoutItem("报告", 31, 700, 20, true),
      layoutItem("PROBLEM", 10, 680, 42),
      layoutItem("SET", 55, 680, 18),
      layoutItem("REPORT", 76, 680, 36, true),
      layoutItem("1", 10, 660, 6, true),
      layoutItem("我的答案", 10, 640, 40),
      layoutItem("D", 65, 640, 6, true),
    ]);

    expect(text).toBe("题集报告\nPROBLEM SET REPORT\n1\n我的答案 D");
  });

  it("rejects layout output over two megabytes", () => {
    expect(() => layoutPdfTextItems([
      layoutItem("示".repeat(700_000), 10, 700, 7_000_000, true),
    ])).toThrow("PDF 提取文字过多");
  });

  it("extracts text from a fixed synthetic PDF without an external command", async () => {
    const text = await extractPdfText(arrayBuffer(syntheticPdf([
      "PROBLEM SET REPORT 2099/07/13",
      "Synthetic assessment fixture",
    ])));

    expect(text).toContain("PROBLEM SET REPORT 2099/07/13");
    expect(text).toContain("Synthetic assessment fixture");
  });

  it("loads the bundled CMap when extracting fixed synthetic Chinese text", async () => {
    await expect(extractPdfText(arrayBuffer(syntheticChinesePdf())))
      .resolves.toBe("题集报告");
  });

  it("reports image-only, encrypted and damaged PDFs separately", async () => {
    await expect(extractPdfText(arrayBuffer(syntheticPdf([]))))
      .rejects.toThrow("当前版本不支持扫描件");
    await expect(extractPdfText(arrayBuffer(Buffer.from(encryptedSyntheticPdf, "base64"))))
      .rejects.toThrow("PDF 已加密");
    await expect(extractPdfText(arrayBuffer(Buffer.from("%PDF damaged", "utf8"))))
      .rejects.toThrow("PDF 无法读取，可能格式损坏");
  });

  it("keeps the existing input size limits", async () => {
    await expect(extractPdfText(new ArrayBuffer(0))).rejects.toThrow("PDF 文件为空");
    await expect(extractPdfText(new ArrayBuffer(15 * 1024 * 1024 + 1)))
      .rejects.toThrow("单份 PDF 不能超过 15 MB");
  });
});
