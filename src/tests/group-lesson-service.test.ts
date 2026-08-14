import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { parseLessonFeedbackMaterial } from "@/lib/feedback-materials";
import {
  confirmGroupLesson,
  createClassGroup,
  createGroupLesson,
  linkGroupLessonSession,
  listSemesterClassGroups,
  updateGroupLesson,
} from "@/services/group-lesson-service";

const marker = "VITEST-GROUP-LESSON";
let semesterId = "";
let otherSemesterId = "";
let firstClassId = "";
let secondClassId = "";
let otherClassId = "";
let firstSessionId = "";
let otherSessionId = "";
let groupId = "";
let lessonId = "";

beforeAll(async () => {
  const semester = await prisma.semester.create({ data: { name: `${marker}-MAIN`, startDate: "2099-01-01", endDate: "2099-06-30" } });
  const other = await prisma.semester.create({ data: { name: `${marker}-OTHER`, startDate: "2099-07-01", endDate: "2099-12-31" } });
  semesterId = semester.id;
  otherSemesterId = other.id;
  const [firstClass, secondClass, otherClass] = await Promise.all([
    prisma.class.create({ data: { semesterId, code: `${marker}-01`, name: "合成一班" } }),
    prisma.class.create({ data: { semesterId, code: `${marker}-02`, name: "合成二班" } }),
    prisma.class.create({ data: { semesterId: otherSemesterId, code: `${marker}-03`, name: "其他学期班" } }),
  ]);
  firstClassId = firstClass.id;
  secondClassId = secondClass.id;
  otherClassId = otherClass.id;
  const [firstSession, otherSession] = await Promise.all([
    prisma.classSession.create({ data: { semesterId, classId: firstClassId, code: "2099010101", date: "2099-01-01", semesterNumber: 1 } }),
    prisma.classSession.create({ data: { semesterId: otherSemesterId, classId: otherClassId, code: "2099070101", date: "2099-07-01", semesterNumber: 1 } }),
  ]);
  firstSessionId = firstSession.id;
  otherSessionId = otherSession.id;
});

afterAll(async () => {
  await prisma.classGroup.deleteMany({ where: { semesterId } });
  await prisma.classSession.deleteMany({ where: { id: { in: [firstSessionId, otherSessionId] } } });
  await prisma.class.deleteMany({ where: { id: { in: [firstClassId, secondClassId, otherClassId] } } });
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
});
