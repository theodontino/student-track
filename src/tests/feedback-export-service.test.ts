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
          draftFeedback: "内部分析：本次能主动订正。",
          reviewStatus: "passed",
          sections: {
            currentFact: { content: "学习测验 4 分；课堂状态 3 分", evidence: [] },
            backgroundBaseline: { content: "本学期个人平均 3.5 分。", evidence: [] },
          },
          contextPreview: { communications: ["2026-07-07 与母亲：关注学习方法"] },
        },
        { id: "student-2", name: "学生乙", feedback: "乙最终反馈" },
      ],
      [{
        studentId: "student-2",
        studentName: "学生乙",
        className: "测试班",
        level: "attention",
        signals: [{ type: "persistent-below-average", label: "长期低于同期班均", evidence: "3/4 次低于同期班均，平均相差 1 分" }],
        qualitativeReasons: [],
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
        预警: "关注：长期低于同期班均（3/4 次低于同期班均，平均相差 1 分）",
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

    const teacherRows = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["教师内部研判"], {
      defval: "",
    });
    expect(Object.keys(teacherRows[0])).toEqual([
      "姓名", "本次事实", "背景基线", "建议反馈文本（模型/已编辑）", "内部分析草稿",
    ]);
    expect(teacherRows).toEqual([
      expect.objectContaining({
        姓名: "学生甲",
        本次事实: "学习测验 4 分；课堂状态 3 分",
        背景基线: "本学期个人平均 3.5 分。",
        "建议反馈文本（模型/已编辑）": "甲最终反馈",
        内部分析草稿: "内部分析：本次能主动订正。",
      }),
      expect.objectContaining({ 姓名: "学生乙" }),
    ]);

    const overview = XLSX.utils.sheet_to_json<Record<string, string | number>>(workbook.Sheets["导出概览"], {
      header: 1,
      defval: "",
    });
    expect(overview).toContainEqual(["AI 审核通过", 1, "████████░░░░░░░░"]);
    expect(overview).toContainEqual(["学习测验", 3, "██████░░░░"]);
  });

  it("leaves unavailable scores blank and excludes internal qualitative labels", async () => {
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
        className: "测试班",
        level: "warning",
        signals: [
          { type: "persistent-below-average", label: "长期低于同期班均", evidence: "3/4 次低于同期班均" },
          { type: "qualitative-feedback", label: "定性反馈关注", evidence: "内部反馈：家长担心" },
        ],
        qualitativeReasons: ["parent-concern"],
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
      预警: "关注：长期低于同期班均（3/4 次低于同期班均）",
    });
    expect(rows[0].预警).not.toContain("定性反馈");
    expect(rows[0].预警).not.toContain("家长担心");
    expect(rows[0].预警).not.toContain("警告");
    expect(rows[1]).toMatchObject({ 姓名: "班级均分", 本次学习测验: "" });
  });
});
