import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { buildFeedbackExportWorkbook } from "@/services/feedback-export-service";

describe("feedback export service", () => {
  it("exports current and previous scores, context, alerts, feedback, and class averages", async () => {
    const prisma = {
      classSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-current",
          classId: "class-1",
          date: "2026-07-08",
          semesterNumber: 3,
        }),
        findMany: vi.fn().mockResolvedValue([{ id: "session-previous" }]),
      },
      sessionMetric: {
        findMany: vi.fn()
          .mockResolvedValueOnce([
            { studentId: "student-1", scoreA: 4, scoreB: 3, scoreC: 5 },
            { studentId: "student-2", scoreA: 2, scoreB: 5, scoreC: 3 },
          ])
          .mockResolvedValueOnce([
            { studentId: "student-1", date: "2026-07-01", createdAt: new Date(), scoreA: 3, scoreB: 4, scoreC: 4 },
            { studentId: "student-2", date: "2026-07-01", createdAt: new Date(), scoreA: 4, scoreB: 4, scoreC: 2 },
          ]),
      },
    };

    const buffer = await buildFeedbackExportWorkbook(
      prisma as never,
      "2026070801",
      [
        {
          id: "student-1",
          name: "学生甲",
          feedback: "甲最终反馈",
          contextPreview: { communications: ["2026-07-07 与母亲：关注学习方法"] },
        },
        { id: "student-2", name: "学生乙", feedback: "乙最终反馈" },
      ],
      [{
        studentId: "student-2",
        studentName: "学生乙",
        class: "测试班",
        dimension: "学习&测验",
        score: 2,
        classAvg: 3,
        deviation: -1,
        severity: "yellow",
        lastActivityAt: "2026-07-08T00:00:00.000Z",
      }],
    );

    const workbook = XLSX.read(buffer, { type: "array" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["课后反馈"], {
      defval: "",
    });

    expect(rows).toEqual([
      expect.objectContaining({
        姓名: "学生甲",
        本次学习测验: 4,
        上次学习测验: 3,
        参考家校背景: "2026-07-07 与母亲：关注学习方法",
        预警: "",
        最终反馈: "甲最终反馈",
      }),
      expect.objectContaining({
        姓名: "学生乙",
        本次学习测验: 2,
        上次课后任务: 2,
        预警: "关注：学习&测验 2 分（班均 3，相差 -1）",
        最终反馈: "乙最终反馈",
      }),
      expect.objectContaining({
        姓名: "班级均分",
        本次学习测验: 3,
        本次精神纪律: 4,
        本次课后任务: 4,
        上次学习测验: 3.5,
        上次精神纪律: 4,
        上次课后任务: 3,
      }),
    ]);
  });

  it("leaves unavailable scores blank and formats attendance alerts", async () => {
    const prisma = {
      classSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-current",
          classId: "class-1",
          date: "2026-07-08",
          semesterNumber: 1,
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      sessionMetric: { findMany: vi.fn().mockResolvedValue([]) },
    };

    const buffer = await buildFeedbackExportWorkbook(
      prisma as never,
      "2026070801",
      [{ id: "student-1", name: "学生甲", feedback: "反馈" }],
      [{
        studentId: "student-1",
        studentName: "学生甲",
        class: "测试班",
        dimension: "考勤",
        score: 2,
        classAvg: 5,
        deviation: -2,
        severity: "yellow",
        lastActivityAt: "2026-07-08T00:00:00.000Z",
      }],
    );

    const workbook = XLSX.read(buffer, { type: "array" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["课后反馈"], {
      defval: "",
    });
    expect(rows[0]).toMatchObject({
      姓名: "学生甲",
      本次学习测验: "",
      上次学习测验: "",
      预警: "关注：累计缺勤 2 次",
    });
    expect(rows[1]).toMatchObject({ 姓名: "班级均分", 本次学习测验: "" });
  });
});
