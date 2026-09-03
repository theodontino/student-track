import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { POST as POST_GROUP_LESSON_ACTION } from "@/app/api/group-lessons/[id]/route";
import { prisma } from "@/lib/prisma";
import { createEmptyLessonFeedbackMaterial, lessonMaterialHasContent, mergeEditedLessonMaterial, parseLessonFeedbackMaterial } from "@/lib/feedback-materials";
import { saveFeedbackScriptLibrary } from "@/services/feedback-script-library-service";
import {
  confirmGroupLesson,
  createClassGroup,
  createGroupLesson,
  linkGroupLessonSession,
} from "@/services/group-lesson-service";

const marker = "VITEST-SEMESTER-COMMON-MATERIAL";
let semesterId = "";
let classId = "";
let groupId = "";
let sessionId = "";
let planId = "";
let existingLessonId = "";

function workbookBuffer(prefix = "") {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["合成学期公共材料"],
    ["课次", "课程主题", "群反馈", "统一测评说明", "全对的私反馈", "有错误的私反馈", "备注"],
    [1, `${prefix}同号一主题`, `${prefix}同号一群反馈`, `${prefix}同号一测评说明`, `${prefix}同号一全对模板`, `${prefix}同号一有误模板`, ""],
    [2, `${prefix}同号二主题`, `${prefix}同号二群反馈`, `${prefix}同号二测评说明`, `${prefix}同号二全对模板`, `${prefix}同号二有误模板`, "二号备注"],
    [3, `${prefix}同号三主题`, `${prefix}同号三群反馈`, `${prefix}同号三测评说明`, `${prefix}同号三全对模板`, `${prefix}同号三有误模板`, ""],
  ]), "学期公共材料");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

async function reapplyRequest(lessonId: string, replaceExisting: boolean) {
  return POST_GROUP_LESSON_ACTION(new NextRequest(`http://localhost/api/group-lessons/${lessonId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reapply_semester_material", replaceExisting }),
  }), { params: Promise.resolve({ id: lessonId }) });
}

beforeAll(async () => {
  const semester = await prisma.semester.create({
    data: { name: marker, startDate: "2099-01-01", endDate: "2099-12-31" },
  });
  semesterId = semester.id;
  const klass = await prisma.class.create({
    data: { semesterId, code: `${marker}-CLASS`, name: "合成材料班" },
  });
  classId = klass.id;
  const group = await createClassGroup(semesterId, {
    name: `${marker}-GROUP`,
    classIds: [classId],
    leadClassId: classId,
  });
  groupId = group.id;

  const manualMaterial = parseLessonFeedbackMaterial("课程标题：旧草稿\n课堂内容：旧内容", "旧测评说明");
  const existing = await createGroupLesson(groupId, {
    title: "第 2 讲",
    sequence: 2,
    material: manualMaterial,
  });
  existingLessonId = existing.id;
  await confirmGroupLesson(existing.id);
  const session = await prisma.classSession.create({
    data: {
      semesterId,
      classId,
      code: "2099123198",
      date: "2099-12-31",
      semesterNumber: 2,
      commonMaterialSnapshot: JSON.stringify({ version: 1, marker: "REAL-SESSION-SNAPSHOT" }),
      commonMaterialConfirmedAt: new Date("2099-01-02T00:00:00.000Z"),
    },
  });
  sessionId = session.id;
  await linkGroupLessonSession(existing.id, { sessionId, syncStatus: "synced", comparable: true });
  const plan = await prisma.feedbackPlan.create({
    data: {
      semesterId,
      classId,
      sessionId,
      type: "class_update",
      outputRequirement: "合成计划要求",
      inputFingerprint: `${marker}-FINGERPRINT`,
      inputSnapshot: JSON.stringify({ version: 2, marker: "PLAN-SNAPSHOT" }),
    },
  });
  planId = plan.id;
});

afterAll(async () => {
  await prisma.feedbackPlan.deleteMany({ where: { semesterId } });
  await prisma.classGroup.deleteMany({ where: { semesterId } });
  await prisma.classSession.deleteMany({ where: { semesterId } });
  await prisma.class.deleteMany({ where: { semesterId } });
  await prisma.semester.deleteMany({ where: { id: semesterId } });
});

describe("semester common material lifecycle", () => {
  it("keeps the workbook topic when a teacher edits body text without an embedded title", () => {
    const existing = {
      ...parseLessonFeedbackMaterial("旧群反馈", "旧测评"),
      lessonTitle: "工作簿课程主题",
      perfectPrivateTemplate: "全对模板",
      errorPrivateTemplate: "有误模板",
      semesterScriptSource: { lessonNumber: 1, libraryUpdatedAt: "2099-01-01T00:00:00.000Z" },
    };
    expect(mergeEditedLessonMaterial(existing, "教师修改后的普通正文", "教师修改后的测评说明")).toMatchObject({
      lessonTitle: "工作簿课程主题",
      groupFeedbackRaw: "教师修改后的普通正文",
      assessmentBriefRaw: "教师修改后的测评说明",
      perfectPrivateTemplate: "全对模板",
      errorPrivateTemplate: "有误模板",
      semesterScriptSource: { lessonNumber: 1 },
    });
  });

  it("does not overwrite existing lessons and auto-copies every same-sequence field into a new draft", async () => {
    expect(lessonMaterialHasContent({ ...createEmptyLessonFeedbackMaterial(), perfectPrivateTemplate: "仅私反馈模板" })).toBe(true);
    const beforeImport = await prisma.groupLesson.findUniqueOrThrow({ where: { id: existingLessonId } });
    await saveFeedbackScriptLibrary(prisma, semesterId, workbookBuffer());
    const afterImport = await prisma.groupLesson.findUniqueOrThrow({ where: { id: existingLessonId } });
    expect(afterImport.materialSnapshot).toBe(beforeImport.materialSnapshot);
    expect(afterImport.title).toBe("第 2 讲");

    const auto = await createGroupLesson(groupId, {
      title: "第 1 讲",
      sequence: 1,
      material: createEmptyLessonFeedbackMaterial(),
    });
    expect(auto).toMatchObject({ title: "同号一主题", revision: 0, confirmedAt: null });
    expect(JSON.parse(auto.materialSnapshot)).toMatchObject({
      lessonTitle: "同号一主题",
      groupFeedbackRaw: "同号一群反馈",
      assessmentBriefRaw: "同号一测评说明",
      perfectPrivateTemplate: "同号一全对模板",
      errorPrivateTemplate: "同号一有误模板",
      semesterScriptSource: { lessonNumber: 1, libraryUpdatedAt: expect.any(String) },
    });

    const unmatched = await createGroupLesson(groupId, {
      title: "第 4 讲",
      sequence: 4,
      material: createEmptyLessonFeedbackMaterial(),
    });
    expect(unmatched.title).toBe("第 4 讲");
    expect(lessonMaterialHasContent(JSON.parse(unmatched.materialSnapshot))).toBe(false);
  });

  it("requires confirmation to reapply and leaves confirmed revisions and business snapshots unchanged", async () => {
    await saveFeedbackScriptLibrary(prisma, semesterId, workbookBuffer("新版"), undefined, true);
    const autoLesson = await prisma.groupLesson.findFirstOrThrow({ where: { groupId, sequence: 1 } });
    const autoReapplied = await reapplyRequest(autoLesson.id, true);
    expect(autoReapplied.status).toBe(200);
    await expect(autoReapplied.json()).resolves.toMatchObject({ lesson: { title: "新版同号一主题" } });

    const lessonBefore = await prisma.groupLesson.findUniqueOrThrow({ where: { id: existingLessonId } });
    const revisionBefore = await prisma.groupLessonRevision.findFirstOrThrow({ where: { groupLessonId: existingLessonId } });
    const sessionBefore = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    const planBefore = await prisma.feedbackPlan.findUniqueOrThrow({ where: { id: planId } });

    const blocked = await reapplyRequest(existingLessonId, false);
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({ error: expect.stringContaining("明确确认") });

    const reapplied = await reapplyRequest(existingLessonId, true);
    expect(reapplied.status).toBe(200);
    await expect(reapplied.json()).resolves.toMatchObject({
      lesson: {
        title: "新版同号二主题",
        revision: lessonBefore.revision,
        material: {
          lessonTitle: "新版同号二主题",
          groupFeedbackRaw: "新版同号二群反馈",
          assessmentBriefRaw: "新版同号二测评说明",
          perfectPrivateTemplate: "新版同号二全对模板",
          errorPrivateTemplate: "新版同号二有误模板",
          semesterScriptSource: { lessonNumber: 2, libraryUpdatedAt: expect.any(String) },
        },
        hasUnconfirmedChanges: true,
      },
    });

    const lessonAfter = await prisma.groupLesson.findUniqueOrThrow({ where: { id: existingLessonId } });
    const revisionAfter = await prisma.groupLessonRevision.findUniqueOrThrow({ where: { id: revisionBefore.id } });
    const sessionAfter = await prisma.classSession.findUniqueOrThrow({ where: { id: sessionId } });
    const planAfter = await prisma.feedbackPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(lessonAfter.revision).toBe(lessonBefore.revision);
    expect(lessonAfter.confirmedAt).toEqual(lessonBefore.confirmedAt);
    expect(revisionAfter.materialSnapshot).toBe(revisionBefore.materialSnapshot);
    expect(revisionAfter.confirmedAt).toEqual(revisionBefore.confirmedAt);
    expect(sessionAfter.commonMaterialSnapshot).toBe(sessionBefore.commonMaterialSnapshot);
    expect(sessionAfter.commonMaterialConfirmedAt).toEqual(sessionBefore.commonMaterialConfirmedAt);
    expect(planAfter.inputSnapshot).toBe(planBefore.inputSnapshot);

    const custom = await createGroupLesson(groupId, {
      title: "教师自定义标题",
      sequence: 3,
      material: parseLessonFeedbackMaterial("教师已有草稿", "教师已有测评"),
    });
    const customReapplied = await reapplyRequest(custom.id, true);
    expect(customReapplied.status).toBe(200);
    await expect(customReapplied.json()).resolves.toMatchObject({
      lesson: { title: "教师自定义标题", material: { lessonTitle: "新版同号三主题" } },
    });
  });
});
