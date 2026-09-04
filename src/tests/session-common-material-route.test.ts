import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { PUT } from "@/app/api/sessions/[id]/common-material/route";
import { mergeEditedLessonMaterial, parseLessonFeedbackMaterial } from "@/lib/feedback-materials";
import { prisma } from "@/lib/prisma";
import { saveFeedbackScriptLibrary } from "@/services/feedback-script-library-service";

const marker = "VITEST-SESSION-CUSTOM-MATERIAL";
let semesterId = "";
let classId = "";
let sessionId = "";
let sessionCode = "";

function request(body: unknown) {
  return PUT(new NextRequest(`http://localhost/api/sessions/${sessionId}/common-material`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: sessionId }) });
}

beforeAll(async () => {
  const semester = await prisma.semester.create({
    data: { name: marker, startDate: "2098-01-01", endDate: "2098-12-31" },
  });
  semesterId = semester.id;
  const klass = await prisma.class.create({
    data: { semesterId, code: `${marker}-CLASS`, name: "合成独立课班" },
  });
  classId = klass.id;
  sessionCode = `${marker}-SESSION`;
  const session = await prisma.classSession.create({
    data: { semesterId, classId, code: sessionCode, date: "2098-06-01", semesterNumber: 1 },
  });
  sessionId = session.id;

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["合成学期公共材料"],
    ["课次", "课程主题", "群反馈", "统一测评说明", "全对的私反馈", "有错误的私反馈"],
    [1, "学期主题", "学期群反馈", "学期测评", "全对模板", "有误模板"],
  ]), "学期公共材料");
  await saveFeedbackScriptLibrary(
    prisma,
    semesterId,
    XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
  );
});

afterAll(async () => {
  await prisma.classSession.deleteMany({ where: { id: sessionId } });
  await prisma.class.deleteMany({ where: { id: classId } });
  await prisma.semester.deleteMany({ where: { id: semesterId } });
});

describe("independent session common material route", () => {
  it("saves a custom course background and binds it to the real session", async () => {
    const libraryBefore = await prisma.semester.findUniqueOrThrow({
      where: { id: semesterId },
      select: { feedbackScriptLibraryJson: true, feedbackScriptLibraryUpdatedAt: true },
    });
    const custom = parseLessonFeedbackMaterial("课程标题：独立课背景\n课堂内容：合成内容", "合成测评说明", "OTHER-SESSION");
    const response = await request({ material: custom });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: sessionCode,
      commonMaterialConfirmedAt: expect.any(String),
      material: {
        sessionCode,
        groupFeedbackRaw: custom.groupFeedbackRaw,
        assessmentBriefRaw: "合成测评说明",
      },
    });
    const stored = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(JSON.parse(stored.commonMaterialSnapshot ?? "null")).toMatchObject({ sessionCode, groupFeedbackRaw: custom.groupFeedbackRaw });
    expect(stored.commonMaterialConfirmedAt).not.toBeNull();
    await expect(prisma.semester.findUniqueOrThrow({
      where: { id: semesterId },
      select: { feedbackScriptLibraryJson: true, feedbackScriptLibraryUpdatedAt: true },
    })).resolves.toEqual(libraryBefore);
  });

  it("keeps the existing lessonNumber API compatible and still supports clearing", async () => {
    const fromLibrary = await request({ lessonNumber: 1 });
    expect(fromLibrary.status).toBe(200);
    await expect(fromLibrary.json()).resolves.toMatchObject({
      material: {
        sessionCode,
        lessonTitle: "学期主题",
        groupFeedbackRaw: "学期群反馈",
        semesterScriptSource: { lessonNumber: 1 },
      },
    });

    const cleared = await request({ lessonNumber: null });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({ material: null, commonMaterialConfirmedAt: null });
  });

  it("stores an edited independent-session background as new custom material", async () => {
    const fromLibrary = await request({ lessonNumber: 1 });
    const libraryMaterial = (await fromLibrary.json()).material;
    const edited = mergeEditedLessonMaterial(libraryMaterial, "独立课自定义背景", "独立课自定义测评说明");
    const response = await request({ material: edited });

    expect(response.status).toBe(200);
    const saved = (await response.json()).material;
    expect(saved).toMatchObject({
      sessionCode,
      groupFeedbackRaw: "独立课自定义背景",
      assessmentBriefRaw: "独立课自定义测评说明",
    });
    expect(saved).not.toHaveProperty("scriptLessonNumber");
    expect(saved).not.toHaveProperty("semesterScriptSource");
    expect(saved).not.toHaveProperty("perfectPrivateTemplate");
    expect(saved).not.toHaveProperty("errorPrivateTemplate");
    expect(saved).not.toHaveProperty("lessonSummary");

    const stored = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(JSON.parse(stored.commonMaterialSnapshot ?? "null")).toEqual(saved);
  });

  it("rejects an invalid custom material without replacing the saved snapshot", async () => {
    await request({ material: parseLessonFeedbackMaterial("保留的背景", "") });
    const before = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    const response = await request({ material: { version: 1, groupFeedbackRaw: "缺少规范字段" } });
    const after = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });

    expect(response.status).toBe(400);
    expect(after.commonMaterialSnapshot).toBe(before.commonMaterialSnapshot);
    expect(after.commonMaterialConfirmedAt).toEqual(before.commonMaterialConfirmedAt);
  });
});
