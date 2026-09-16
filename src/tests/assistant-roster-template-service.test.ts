import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { buildAssistantRosterTemplate } from "@/services/assistant-roster-template-service";
import { parseAssistantRosterFiles } from "@/services/assistant-roster-import-service";

describe("assistant roster template service", () => {
  it("builds a session-prefilled workbook that the existing importer reads without conversion", async () => {
    const prisma = {
      classSession: {
        findUnique: vi.fn().mockResolvedValue({
          code: "TEST-SESSION-01",
          date: "2099-08-13",
          semesterNumber: 2,
          class: {
            code: "TEST-CLASS-01",
            name: "合成测试班",
            enrollments: [
              { student: { name: "李四", studentId: "TEST-002" } },
              { student: { name: "张三", studentId: "TEST-001" } },
            ],
          },
        }),
      },
    };
    const template = await buildAssistantRosterTemplate(prisma as never, "TEST-SESSION-01");
    const workbook = XLSX.read(template, { type: "array" });
    const sheet = workbook.Sheets["课堂记录"]!;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    expect(matrix[0]).toEqual(expect.arrayContaining(["日期", "2099-08-13", "课次", "2"]));
    expect(matrix[1]).toEqual(["姓名", "听课证号", "班级编号", "班级名称", "出入门测1-5", "课堂纪律1-5", "课后作业1-5", "备注"]);
    expect(matrix[2]).toEqual(expect.arrayContaining(["张三", "TEST-001", "TEST-CLASS-01", "合成测试班"]));

    sheet.F3 = { t: "n", v: 5 };
    sheet.H3 = { t: "s", v: "合成课堂观察" };
    const filled = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const parsed = parseAssistantRosterFiles([{ name: "assistant-template.xlsx", buffer: filled }], "2099-08-13");
    expect(parsed).toEqual([expect.objectContaining({ name: "张三", studentId: "TEST-001", classCode: "TEST-CLASS-01", date: "2099-08-13", lessonNumber: "2", scoreB: 5, note: "合成课堂观察" })]);
  });
});
