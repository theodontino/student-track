/** In-memory synthetic report using the same CMap as the PDF extraction tests. */
export function syntheticAssessmentPdf(studentName: string, date: string, correctRate = 84) {
  const lines = [
    "题集报告", `PROBLEM SET REPORT ${date.replaceAll("-", "/")}`,
    "01合成测试基础", `学员：${studentName}`,
    `你合计完成了25道小题，正确率为${correctRate}%，高于平均正确率72%。`,
  ];
  const stream = ["BT", "/F1 12 Tf", "72 720 Td", ...lines.flatMap((line, index) => [
    ...(index ? ["0 -18 Td"] : []),
    `<${Array.from(line).map((character) => character.charCodeAt(0).toString(16).padStart(4, "0")).join("")}> Tj`,
  ]), "ET"].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(source, "ascii")).buffer;
}
