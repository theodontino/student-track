import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { parseLessonFeedbackMaterial } from "@/lib/feedback-materials";
import {
  confirmGroupLesson,
  createClassGroup,
  createGroupLesson,
  deleteClassGroup,
  deleteGroupLesson,
  getSessionGroupProgress,
  linkGroupLessonSession,
  listSemesterClassGroups,
  setSessionGroupProgress,
  unlinkGroupLessonSession,
  updateClassGroup,
  updateGroupLesson,
} from "@/services/group-lesson-service";

const marker = "VITEST-GROUP-LESSON";
let semesterId = "";
let otherSemesterId = "";
let firstClassId = "";
let secondClassId = "";
let disposableClassId = "";
let otherClassId = "";
let firstSessionId = "";
let secondSessionId = "";
let nextFirstSessionId = "";
let otherSessionId = "";
let groupId = "";
let lessonId = "";

beforeAll(async () => {
  const semester = await prisma.semester.create({ data: { name: `${marker}-MAIN`, startDate: "2099-01-01", endDate: "2099-06-30" } });
  const other = await prisma.semester.create({ data: { name: `${marker}-OTHER`, startDate: "2099-07-01", endDate: "2099-12-31" } });
  semesterId = semester.id;
  otherSemesterId = other.id;
  const [firstClass, secondClass, disposableClass, otherClass] = await Promise.all([
    prisma.class.create({ data: { semesterId, code: `${marker}-01`, name: "合成一班" } }),
    prisma.class.create({ data: { semesterId, code: `${marker}-02`, name: "合成二班" } }),
    prisma.class.create({ data: { semesterId, code: `${marker}-03`, name: "合成临时班" } }),
    prisma.class.create({ data: { semesterId: otherSemesterId, code: `${marker}-03`, name: "其他学期班" } }),
  ]);
  firstClassId = firstClass.id;
  secondClassId = secondClass.id;
  disposableClassId = disposableClass.id;
  otherClassId = otherClass.id;
  const [firstSession, secondSession, nextFirstSession, otherSession] = await Promise.all([
    prisma.classSession.create({ data: { semesterId, classId: firstClassId, code: "2099010101", date: "2099-01-01", semesterNumber: 1 } }),
    prisma.classSession.create({ data: { semesterId, classId: secondClassId, code: "2099010102", date: "2099-01-01", semesterNumber: 1 } }),
    prisma.classSession.create({ data: { semesterId, classId: firstClassId, code: "2099010801", date: "2099-01-08", semesterNumber: 2 } }),
    prisma.classSession.create({ data: { semesterId: otherSemesterId, classId: otherClassId, code: "2099070101", date: "2099-07-01", semesterNumber: 1 } }),
  ]);
  firstSessionId = firstSession.id;
  secondSessionId = secondSession.id;
  nextFirstSessionId = nextFirstSession.id;
  otherSessionId = otherSession.id;
});

afterAll(async () => {
  await prisma.classGroup.deleteMany({ where: { semesterId } });
  await prisma.classSession.deleteMany({ where: { id: { in: [firstSessionId, secondSessionId, nextFirstSessionId, otherSessionId] } } });
  await prisma.class.deleteMany({ where: { id: { in: [firstClassId, secondClassId, disposableClassId, otherClassId] } } });
  await prisma.semester.deleteMany({ where: { id: { in: [semesterId, otherSemesterId] } } });
});

describe("group lesson service", () => {
  it("creates one current group for parallel classes and rejects cross-semester members", async () => {
    const group = await createClassGroup(semesterId, { name: "合成平行班", classIds: [firstClassId, secondClassId], leadClassId: firstClassId });
    groupId = group.id;
    expect(group.memberships).toHaveLength(2);
    expect(group.leadClassId).toBe(firstClassId);
    await expect(createClassGroup(semesterId, { name: "重复分组", classIds: [firstClassId], leadClassId: firstClassId })).rejects.toMatchObject({ status: 409 });
    await expect(createClassGroup(semesterId, { name: "跨学期", classIds: [otherClassId], leadClassId: otherClassId })).rejects.toMatchObject({ status: 409 });
  });

  it("creates immutable confirmed material revisions", async () => {
    const material = parseLessonFeedbackMaterial("课程标题：氧化还原\n课堂内容：电子转移", "出门测：电子转移方向");
    const lesson = await createGroupLesson(groupId, { title: "氧化还原", sequence: 1, material });
    lessonId = lesson.id;
    const first = await confirmGroupLesson(lesson.id);
    const repeated = await confirmGroupLesson(lesson.id);
    expect(first.revision).toBe(1);
    expect(repeated.id).toBe(first.id);

    const updatedMaterial = parseLessonFeedbackMaterial("课程标题：氧化还原\n课堂内容：电子转移\n课堂重点：守恒", "出门测：电子转移方向");
    await updateGroupLesson(lesson.id, { material: updatedMaterial });
    const second = await confirmGroupLesson(lesson.id);
    expect(second.revision).toBe(2);
    await expect(prisma.groupLessonRevision.count({ where: { groupLessonId: lesson.id } })).resolves.toBe(2);
  });

  it("links only real sessions from member classes", async () => {
    const link = await linkGroupLessonSession(lessonId, { sessionId: firstSessionId, syncStatus: "synced", comparable: true });
    expect(link).toMatchObject({ sessionId: firstSessionId, comparable: true });
    await expect(linkGroupLessonSession(lessonId, { sessionId: otherSessionId, syncStatus: "diverged", differenceSummary: "其他学期", comparable: false })).rejects.toMatchObject({ status: 409 });

    const groups = await listSemesterClassGroups(semesterId);
    expect(groups[0].lessons[0]).toMatchObject({ revision: 2, hasUnconfirmedChanges: false });
    expect(groups[0].lessons[0].sessionLinks).toHaveLength(1);
  });

  it("freezes the sequence after a real session is linked but still allows content edits", async () => {
    await expect(updateGroupLesson(lessonId, { sequence: 2 })).rejects.toMatchObject({
      status: 409,
      message: "共同课已关联真实课次，不能修改讲次序号",
    });

    const material = parseLessonFeedbackMaterial("课程标题：氧化还原（修订）\n课堂内容：电子转移与守恒", "出门测：电子转移方向");
    const updated = await updateGroupLesson(lessonId, { sequence: 1, title: "氧化还原（修订）", material });
    expect(updated).toMatchObject({ sequence: 1, title: "氧化还原（修订）" });
    expect(JSON.parse(updated.materialSnapshot)).toMatchObject({ groupFeedbackRaw: material.groupFeedbackRaw });
  });

  it("rejects a second real session from the same class in one shared lesson", async () => {
    await expect(linkGroupLessonSession(lessonId, {
      sessionId: nextFirstSessionId,
      syncStatus: "synced",
      comparable: true,
    })).rejects.toMatchObject({
      status: 409,
      message: "当前班级已经有真实课次关联到这一讲",
    });
    await expect(prisma.groupLessonSession.findUnique({ where: { sessionId: nextFirstSessionId } })).resolves.toBeNull();
  });

  it("deletes only unused draft lessons", async () => {
    const material = parseLessonFeedbackMaterial("课程标题：可删除草稿\n课堂内容：合成内容", "出门测：合成题");
    const unused = await createGroupLesson(groupId, { title: "可删除草稿", sequence: 4, material });
    await expect(deleteGroupLesson(unused.id)).resolves.toEqual({ success: true });
    await expect(prisma.groupLesson.findUnique({ where: { id: unused.id } })).resolves.toBeNull();

    const linked = await createGroupLesson(groupId, { title: "已关联草稿", sequence: 4, material });
    await linkGroupLessonSession(linked.id, { sessionId: nextFirstSessionId, syncStatus: "synced", comparable: true });
    await expect(deleteGroupLesson(linked.id)).rejects.toMatchObject({ status: 409, message: "共同课已关联真实课次，不能删除" });
    await expect(unlinkGroupLessonSession(linked.id, nextFirstSessionId)).resolves.toEqual({ success: true });
    await expect(deleteGroupLesson(linked.id)).resolves.toEqual({ success: true });

    const confirmed = await createGroupLesson(groupId, { title: "已确认共同课", sequence: 2, material });
    await confirmGroupLesson(confirmed.id);
    await expect(deleteGroupLesson(confirmed.id)).rejects.toMatchObject({ status: 409, message: "共同课已有确认修订，不能删除" });

    const referenced = await createGroupLesson(groupId, { title: "已被反馈引用", sequence: 3, material });
    const revision = await confirmGroupLesson(referenced.id);
    await prisma.feedbackPlanBatch.create({
      data: {
        requestKey: `${marker}-REFERENCED-BATCH`,
        semesterId,
        type: "event_micro",
        outputRequirement: "合成反馈要求",
        sharedLessonRevisionId: revision.id,
      },
    });
    await expect(deleteGroupLesson(referenced.id)).rejects.toMatchObject({ status: 409, message: "共同课已被反馈批次引用，不能删除" });
  });

  it("deletes a class group that has no lessons", async () => {
    const disposable = await createClassGroup(semesterId, {
      name: "合成临时班级组",
      classIds: [disposableClassId],
      leadClassId: disposableClassId,
    });
    await expect(deleteClassGroup(disposable.id)).resolves.toEqual({ success: true });
    await expect(prisma.classGroup.findUnique({ where: { id: disposable.id } })).resolves.toBeNull();
    await expect(prisma.classGroupMembership.findUnique({ where: { classId: disposableClassId } })).resolves.toBeNull();
  });

  it("restores a linked lesson from historical session links after a class leaves the current group", async () => {
    await linkGroupLessonSession(lessonId, {
      sessionId: secondSessionId,
      syncStatus: "diverged",
      differenceSummary: "合成历史差异",
      comparable: false,
    });
    const originalLink = await prisma.groupLessonSession.findUniqueOrThrow({ where: { sessionId: secondSessionId } });
    await updateClassGroup(groupId, { name: "合成平行班", classIds: [firstClassId], leadClassId: firstClassId });

    const historicalUnlinkError = "该课次记录的是原班级组的历史进度，不能直接解除关联；如需纠正，请改挂到原班级组内的其他共同讲次";
    await expect(setSessionGroupProgress({ sessionId: secondSessionId, groupLessonId: null })).rejects.toMatchObject({
      status: 409,
      message: historicalUnlinkError,
    });
    await expect(unlinkGroupLessonSession(lessonId, secondSessionId)).rejects.toMatchObject({
      status: 409,
      message: historicalUnlinkError,
    });
    await expect(prisma.groupLessonSession.findUniqueOrThrow({ where: { sessionId: secondSessionId } })).resolves.toMatchObject({
      id: originalLink.id,
      groupLessonId: lessonId,
    });

    const fromFormerMember = await getSessionGroupProgress(secondSessionId);
    expect(fromFormerMember).toMatchObject({
      status: "linked",
      lesson: { id: lessonId },
      group: {
        id: groupId,
        members: [
          { classId: firstClassId, session: { id: firstSessionId } },
          { classId: secondClassId, session: { id: secondSessionId } },
        ],
      },
    });

    await expect(setSessionGroupProgress({ sessionId: secondSessionId, groupLessonId: lessonId })).resolves.toMatchObject({
      progress: { status: "linked", lesson: { id: lessonId } },
    });
    await expect(prisma.groupLessonSession.findUniqueOrThrow({ where: { sessionId: secondSessionId } })).resolves.toMatchObject({
      id: originalLink.id,
      groupLessonId: lessonId,
      syncStatus: "diverged",
      differenceSummary: "合成历史差异",
      comparable: false,
    });

    const material = parseLessonFeedbackMaterial("课程标题：历史组内调整\n课堂内容：合成内容", "出门测：合成题");
    const historicalAlternative = await createGroupLesson(groupId, { title: "历史组内调整", sequence: 4, material });
    await expect(setSessionGroupProgress({ sessionId: secondSessionId, groupLessonId: historicalAlternative.id })).resolves.toMatchObject({
      progress: { status: "linked", lesson: { id: historicalAlternative.id } },
    });
    await expect(prisma.groupLessonSession.findUniqueOrThrow({ where: { sessionId: secondSessionId } })).resolves.toMatchObject({
      id: originalLink.id,
      groupLessonId: historicalAlternative.id,
      syncStatus: "synced",
      differenceSummary: null,
      comparable: true,
    });

    const currentGroup = await createClassGroup(semesterId, {
      name: "合成二班新组",
      classIds: [secondClassId],
      leadClassId: secondClassId,
    });
    await expect(setSessionGroupProgress({ sessionId: secondSessionId, groupLessonId: null })).rejects.toMatchObject({
      status: 409,
      message: historicalUnlinkError,
    });
    await expect(unlinkGroupLessonSession(historicalAlternative.id, secondSessionId)).rejects.toMatchObject({
      status: 409,
      message: historicalUnlinkError,
    });
    const unrelatedLesson = await createGroupLesson(currentGroup.id, { title: "新组共同课", sequence: 1, material });
    await expect(setSessionGroupProgress({ sessionId: secondSessionId, groupLessonId: unrelatedLesson.id })).rejects.toMatchObject({
      status: 409,
      message: "历史课次只能在原班级组内调整共同进度",
    });
    await expect(prisma.groupLessonSession.findUniqueOrThrow({ where: { sessionId: secondSessionId } })).resolves.toMatchObject({
      id: originalLink.id,
      groupLessonId: historicalAlternative.id,
    });

    const unlinkedNextLesson = await getSessionGroupProgress(nextFirstSessionId);
    expect(unlinkedNextLesson).toMatchObject({
      status: "independent",
      lesson: null,
      group: { id: groupId, members: [{ classId: firstClassId, session: null }] },
    });
  });
});
