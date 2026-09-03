import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { GET, POST } from "@/app/api/feedback/script-library/route";
import { GET as GET_TEMPLATE } from "@/app/api/feedback/script-library/template/route";
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

function uploadForm(semesterId: string, options: { sessionCode?: string; replaceExisting?: boolean; title?: string } = {}) {
  const form = new FormData();
  form.set("semesterId", semesterId);
  if (options.sessionCode) form.set("sessionCode", options.sessionCode);
  if (options.replaceExisting) form.set("replaceExisting", "true");
  form.set("file", new File([workbookBytes()], options.title ?? "scripts.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));
  return form;
}

describe("/api/feedback/script-library", () => {
  it("uploads one xlsx per semester and returns it with the session recommendation", async () => {
    const semester = await prisma.semester.create({
      data: { name: semesterName, startDate: "2099-01-01", endDate: "2099-12-31" },
    });
    await prisma.classSession.create({
      data: { code: sessionCode, semesterId: semester.id, semesterNumber: 1, date: "2099-01-01" },
    });
    const saved = await POST(new NextRequest("http://localhost/api/feedback/script-library", {
      method: "POST",
      body: uploadForm(semester.id, { sessionCode }),
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

    const replacementRequired = await POST(new NextRequest("http://localhost/api/feedback/script-library", {
      method: "POST",
      body: uploadForm(semester.id),
    }));
    expect(replacementRequired.status).toBe(409);
    await expect(replacementRequired.json()).resolves.toMatchObject({ error: expect.stringContaining("明确确认") });

    const replaced = await POST(new NextRequest("http://localhost/api/feedback/script-library", {
      method: "POST",
      body: uploadForm(semester.id, { replaceExisting: true, title: "a-local-upload-name.xlsx" }),
    }));
    expect(replaced.status).toBe(200);
    const stored = await prisma.semester.findUniqueOrThrow({ where: { id: semester.id } });
    expect(stored.feedbackScriptLibraryName).toBe("测试 API 话术库");
    expect(stored.feedbackScriptLibraryJson).not.toContain("a-local-upload-name.xlsx");
  });

  it("downloads a synthetic xlsx template with required and optional columns", async () => {
    const response = await GET_TEMPLATE();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(response.headers.get("content-disposition")).toContain("semester-common-material-template.xlsx");
    const workbook = XLSX.read(await response.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: "" });
    expect(rows[1]).toEqual(["课次", "课程主题", "群反馈", "统一测评说明", "全对的私反馈", "有错误的私反馈", "备注"]);
    expect(rows[2]).toEqual([1, "示例课程主题", "示例群反馈", "示例统一测评说明", "示例全对私反馈", "示例有错误私反馈", "示例备注"]);
  });
});
