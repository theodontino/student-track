import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { analyzeStudentRosterRows, parseStudentRosterWorkbook, selectStudentRosterRows } from "@/services/student-roster-import-service";

function workbookBuffer(rows: unknown[][]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "原始花名册");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("student roster import service", () => {
  it("recognizes an institution wide roster and groups it by subject, teacher, and class", () => {
    const parsed = parseStudentRosterWorkbook(workbookBuffer([
      ["管理部门", "教师", "班级编码", "班级名称", "班级对应科目", "学员编号", "学员姓名", "在读学校"],
      ["合成部门", "测试教师甲", "TEST-E01", "合成英语班", "英语", "TEST-STUDENT-001", "张三", "合成学校"],
      ["合成部门", "测试教师乙", "TEST-M01", "合成数学班", "数学", "TEST-STUDENT-001", "张三", "合成学校"],
      ["合成部门", "测试教师甲", "TEST-E01", "合成英语班", "英语", "TEST-STUDENT-002", "李四", "合成学校"],
    ]), "xlsx");

    expect(parsed.error).toBeUndefined();
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toMatchObject({ name: "张三", studentId: "TEST-STUDENT-001", classCode: "TEST-E01", className: "合成英语班", subject: "英语", teacher: "测试教师甲", gender: "" });
    const analysis = analyzeStudentRosterRows(parsed.rows, parsed.detectedColumns);
    expect(analysis.subjects).toEqual(["数学", "英语"]);
    expect(analysis.classes).toEqual(expect.arrayContaining([
      expect.objectContaining({ classCode: "TEST-E01", subject: "英语", teacher: "测试教师甲", rowCount: 2 }),
      expect.objectContaining({ classCode: "TEST-M01", subject: "数学", teacher: "测试教师乙", rowCount: 1 }),
    ]));
    expect(selectStudentRosterRows(parsed.rows, ["TEST-E01"]).map((row) => row.studentId)).toEqual(["TEST-STUDENT-001", "TEST-STUDENT-002"]);
  });

  it("keeps the existing compact CSV headers compatible", () => {
    const csv = new TextEncoder().encode("姓名,班级,学号,性别\n王五,TEST-C01,TEST-003,女").buffer;
    const parsed = parseStudentRosterWorkbook(csv, "csv");
    expect(parsed.rows).toEqual([expect.objectContaining({ name: "王五", classCode: "TEST-C01", studentId: "TEST-003", gender: "女" })]);
  });
});
