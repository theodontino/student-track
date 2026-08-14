import { afterEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import {
  getFeedbackScriptLibrary,
  parseFeedbackScriptWorkbook,
  saveFeedbackScriptLibrary,
} from "@/services/feedback-script-library-service";

const semesterName = "TEST-FEEDBACK-SCRIPT-LIBRARY";
const sessionCode = "TEST-FEEDBACK-SCRIPT-SESSION";

function workbookBuffer(rows: unknown[][]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

function exampleWorkbook() {
  return workbookBuffer([
    ["测试学期群反馈与私反馈"],
    ["课次", "教研内容", "主备人", "群反馈", "全对的私反馈", "有错误的私反馈", "备注", ""],
    [1, "集合", "测试教师", "第一课群反馈", "第一课全对模板", "第X题需要订正", "", "额外内容"],
    [2, "阶段检测", "测试教师", "第二课群反馈", "今日私反馈为续班话术", "", "阶段检测"],
    [3, "函数", "测试教师", "", "", "", "待补充"],
  ]);
}

afterEach(async () => {
  await prisma.classSession.deleteMany({ where: { code: sessionCode } });
  await prisma.semester.deleteMany({ where: { name: semesterName } });
});

describe("feedback script library service", () => {
  it("parses supported columns, keeps blank lesson slots, and warns about unsupported content", () => {
    const parsed = parseFeedbackScriptWorkbook(exampleWorkbook());

    expect(parsed.name).toBe("测试学期群反馈与私反馈");
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]).toMatchObject({
      lessonNumber: 1,
      topic: "集合",
      groupFeedback: "第一课群反馈",
      perfectPrivateFeedback: "第一课全对模板",
      errorPrivateFeedback: "第X题需要订正",
    });
    expect(parsed.entries[1].perfectPrivateFeedback).toBe("");
    expect(parsed.entries[2]).toMatchObject({
      lessonNumber: 3,
      groupFeedback: "",
      perfectPrivateFeedback: "",
      errorPrivateFeedback: "",
    });
    expect(parsed.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("未命名列 H"),
      expect.stringContaining("续班话术"),
    ]));
  });

  it("replaces one semester library and recommends the selected session progress", async () => {
    const semester = await prisma.semester.create({
      data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" },
    });
    await prisma.classSession.create({
      data: {
        code: sessionCode,
        semesterId: semester.id,
        semesterNumber: 2,
        date: "2099-01-02",
      },
    });

    const saved = await saveFeedbackScriptLibrary(prisma, semester.id, exampleWorkbook(), sessionCode);
    expect(saved.recommendedLessonNumber).toBe(2);
    expect(saved.library?.entries).toHaveLength(3);
    expect(saved.library?.version).toBe(2);
    expect(saved.library?.entries[0]?.material).toMatchObject({
      scriptLessonNumber: 1,
      semesterScriptSource: { lessonNumber: 1 },
    });

    const restored = await getFeedbackScriptLibrary(prisma, semester.id, sessionCode);
    expect(restored).toMatchObject({
      recommendedLessonNumber: 2,
      library: { name: "测试学期群反馈与私反馈" },
    });
    expect(restored.library?.version).toBe(2);
    const stored = await prisma.semester.findUniqueOrThrow({ where: { id: semester.id } });
    expect(stored.feedbackScriptLibraryJson).toContain("第一课群反馈");
    expect(stored.feedbackScriptLibraryJson).not.toContain(".xlsx");
  });

  it("rejects duplicate lessons instead of silently choosing one", () => {
    expect(() => parseFeedbackScriptWorkbook(workbookBuffer([
      ["课次", "群反馈", "全对的私反馈", "有错误的私反馈"],
      [1, "A", "B", "C"],
      ["第1课", "D", "E", "F"],
    ]))).toThrow("第 1 课重复");
  });

  it("normalizes a stored v1 library into v2 material entries", async () => {
    const semester = await prisma.semester.create({
      data: {
        name: `${semesterName}-V1`,
        startDate: "2099-01-01",
        endDate: "2099-12-31",
        feedbackScriptLibraryName: "旧话术库",
        feedbackScriptLibraryJson: JSON.stringify({ version: 1, name: "旧话术库", warnings: [], entries: [{ lessonNumber: 4, topic: "旧课", groupFeedback: "旧群反馈", perfectPrivateFeedback: "全对", errorPrivateFeedback: "有误", note: "" }] }),
        feedbackScriptLibraryUpdatedAt: new Date("2099-01-04T00:00:00.000Z"),
      },
    });
    const restored = await getFeedbackScriptLibrary(prisma, semester.id);
    expect(restored.library).toMatchObject({ version: 2, entries: [{ lessonNumber: 4, material: { semesterScriptSource: { lessonNumber: 4, libraryUpdatedAt: "2099-01-04T00:00:00.000Z" } } }] });
    await prisma.semester.delete({ where: { id: semester.id } });
  });
});
