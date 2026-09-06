import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { normalizeAssistantRosterDate, parseAssistantRosterFiles } from "@/services/assistant-roster-import-service";

function workbookBuffer(rows: unknown[][]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Worksheet");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("assistant roster import service", () => {
  it("uses the selected session year for common month-day date formats", () => {
    expect(normalizeAssistantRosterDate("8.13", "2026-08-13")).toBe("2026-08-13");
    expect(normalizeAssistantRosterDate("08-13", "2026-08-13")).toBe("2026-08-13");
    expect(normalizeAssistantRosterDate("2026/8/13", "2026-08-13")).toBe("2026-08-13");
    expect(normalizeAssistantRosterDate("8月13日", "2026-08-13")).toBe("2026-08-13");
  });

  it("parses assistant roster rows and maps score columns to A/B/C", () => {
    const rows = parseAssistantRosterFiles([{
      name: "3群学员列表.xlsx",
      buffer: workbookBuffer([
        ["日期", "7/6/26", "", "", "课次", "1", "", "备注"],
        ["姓名", "听证课号", "班级编号", "班级", "课堂纪律1-5", "课后作业1-5", "出入门测1-5", "备注"],
        ["陈歆怡", "UH045160021", "UH04516", "乐桥三档A", "5", "/", "/", "正常参与课堂"],
        ["刘小鱼", "UH045160013", "UH04516", "乐桥三档A", "4", "/", "4.2", "和旁边同学讲话"],
      ]),
    }]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "陈歆怡",
      studentId: "UH045160021",
      classCode: "UH04516",
      className: "乐桥三档A",
      date: "2026-07-06",
      lessonNumber: "1",
      scoreA: null,
      scoreB: 5,
      scoreC: null,
      note: "正常参与课堂",
    });
    expect(rows[1]).toMatchObject({
      name: "刘小鱼",
      scoreA: 4.2,
      scoreB: 4,
      scoreC: null,
      note: "和旁边同学讲话",
    });
  });

  it("inherits merged-like class cells and ignores empty classroom rows", () => {
    const rows = parseAssistantRosterFiles([{
      name: "4群学员列表.xlsx",
      buffer: workbookBuffer([
        ["日期", "2026-07-06", "", "", "课次", "1"],
        ["听证课号", "姓名", "班级编号", "班级", "课堂纪律1-5", "课后作业1-5", "出入门测1-5", "备注（总体都比较认真）"],
        ["UH045200027", "陈问", "UH04520", "乐桥四档A", "5", "/", "/", "正常参与课堂"],
        ["UH045200028", "董馨张瑶", "", "", "5", "/", "/", "一直在笔记，上课认真"],
        ["UH045200029", "丁紫月", "", "", "", "", "", ""],
      ]),
    }]);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      name: "董馨张瑶",
      classCode: "UH04520",
      className: "乐桥四档A",
      scoreB: 5,
      note: "一直在笔记，上课认真",
    });
  });
});
