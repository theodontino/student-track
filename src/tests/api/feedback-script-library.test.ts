import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { GET, POST } from "@/app/api/feedback/script-library/route";
import { prisma } from "@/lib/prisma";

const semesterName = "TEST-API-FEEDBACK-SCRIPT-LIBRARY";
const sessionCode = "TEST-API-FEEDBACK-SCRIPT-SESSION";

function workbookBytes() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["测试 API 话术库"],
    ["课次", "教研内容", "群反馈", "全对的私反馈", "有错误的私反馈"],
    [1, "集合", "群反馈模板", "全对模板", "有误模板"],
  ]), "Sheet1");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

afterEach(async () => {
  await prisma.classSession.deleteMany({ where: { code: sessionCode } });
  await prisma.semester.deleteMany({ where: { name: semesterName } });
});

describe("/api/feedback/script-library", () => {
  it("uploads one xlsx per semester and returns it with the session recommendation", async () => {
    const semester = await prisma.semester.create({
      data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" },
    });
    await prisma.classSession.create({
      data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01" },
    });
    const form = new FormData();
    form.set("semesterId", semester.id);
    form.set("sessionCode", sessionCode);
    form.set("file", new File([workbookBytes()], "scripts.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));

    const saved = await POST(new NextRequest("http://localhost/api/feedback/script-library", {
      method: "POST",
      body: form,
    }));
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      recommendedLessonNumber: 1,
      library: {
        name: "测试 API 话术库",
        entries: [{ lessonNumber: 1, groupFeedback: "群反馈模板" }],
      },
    });

    const restored = await GET(new NextRequest(
      `http://localhost/api/feedback/script-library?semesterId=${semester.id}&sessionCode=${sessionCode}`,
    ));
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      recommendedLessonNumber: 1,
      library: { entries: [{ perfectPrivateFeedback: "全对模板", errorPrivateFeedback: "有误模板" }] },
    });
  });
});
