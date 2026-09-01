import { prisma } from "../src/lib/prisma";
import { parseLessonFeedbackMaterial } from "../src/lib/feedback-materials";

const fixture = {
  semester: { id: "test-feedback-kit-semester", name: "【测试】课后工作台匹配验收", startDate: "2099-07-01", endDate: "2099-08-31" },
  classes: [
    { id: "test-feedback-kit-class-a", code: "TEST-FEEDBACK-A", name: "测试一班" },
    { id: "test-feedback-kit-class-b", code: "TEST-FEEDBACK-B", name: "测试二班" },
  ],
  students: [
    { id: "test-feedback-kit-student-1", name: "张三", studentId: "TEST20260001", gender: "男", classIndex: 0 },
    { id: "test-feedback-kit-student-2", name: "李四", studentId: "TEST20260002", gender: "女", classIndex: 0 },
    { id: "test-feedback-kit-student-3", name: "王五", studentId: "TEST20260003", gender: "男", classIndex: 0 },
    { id: "test-feedback-kit-student-4", name: "赵六", studentId: "TEST20260004", gender: "女", classIndex: 1 },
    { id: "test-feedback-kit-student-5", name: "孙七", studentId: "TEST20260005", gender: "男", classIndex: 1 },
    { id: "test-feedback-kit-student-6", name: "周八", studentId: "TEST20260006", gender: "女", classIndex: 1 },
  ],
  group: { id: "test-feedback-kit-group", name: "【测试】课后工作台测试组" },
  lessons: [
    { sequence: 1, date: "2099-07-13", topic: "离子反应基础", codes: ["2099071301", "2099071302"] },
    { sequence: 2, date: "2099-07-20", topic: "离子方程式书写", codes: ["2099072001", "2099072002"] },
  ],
} as const;

function material(sequence: number, topic: string) {
  return {
    ...parseLessonFeedbackMaterial(
      `【合成测试】第${sequence}讲《${topic}》：用于课后工作台匹配验收。`,
      "【合成测试】个人表现只以测试 Excel 和测试 PDF 为准。",
    ),
    lessonTitle: topic,
    scriptLessonNumber: sequence,
  };
}

async function main() {
  const existing = await prisma.semester.findUnique({
    where: { id: fixture.semester.id },
    include: { classes: true, classGroups: { include: { memberships: true, lessons: { include: { sessionLinks: true } } } } },
  });
  if (existing) {
    const complete = existing.name === fixture.semester.name
      && existing.classes.length === fixture.classes.length
      && existing.classGroups.length === 1
      && existing.classGroups[0]?.memberships.length === 2
      && existing.classGroups[0]?.lessons.length === 2
      && existing.classGroups[0]?.lessons.every((lesson) => lesson.sessionLinks.length === 2);
    if (!complete) throw new Error("测试班级组已部分存在；请先运行清理脚本后重新安装");
    console.log("测试班级组已经完整安装，无需重复创建");
    return;
  }

  const conflictingStudents = await prisma.student.count({ where: { studentId: { in: fixture.students.map((student) => student.studentId) } } });
  const conflictingSessions = await prisma.classSession.count({ where: { code: { in: fixture.lessons.flatMap((lesson) => lesson.codes) } } });
  if (conflictingStudents || conflictingSessions) throw new Error("固定测试学号或课次编号已被占用，未写入任何数据");

  await prisma.$transaction(async (tx) => {
    await tx.semester.create({ data: fixture.semester });
    await tx.class.createMany({ data: fixture.classes.map((item) => ({ ...item, semesterId: fixture.semester.id })) });
    for (const student of fixture.students) {
      await tx.student.create({ data: { id: student.id, name: student.name, studentId: student.studentId, gender: student.gender } });
      await tx.studentClassEnrollment.create({
        data: {
          id: `test-feedback-kit-enrollment-${student.id.slice(-1)}`,
          studentId: student.id,
          semesterId: fixture.semester.id,
          classId: fixture.classes[student.classIndex].id,
          rosterStatus: "ACTIVE",
        },
      });
    }
    await tx.classGroup.create({
      data: {
        id: fixture.group.id,
        semesterId: fixture.semester.id,
        name: fixture.group.name,
        leadClassId: fixture.classes[0].id,
        memberships: { create: fixture.classes.map((item, index) => ({ id: `test-feedback-kit-membership-${index + 1}`, classId: item.id })) },
      },
    });
    for (const lesson of fixture.lessons) {
      const snapshot = JSON.stringify(material(lesson.sequence, lesson.topic));
      for (const [classIndex, code] of lesson.codes.entries()) {
        await tx.classSession.create({
          data: {
            id: `test-feedback-kit-session-${lesson.sequence}-${classIndex + 1}`,
            code,
            date: lesson.date,
            semesterNumber: lesson.sequence,
            semesterId: fixture.semester.id,
            classId: fixture.classes[classIndex].id,
          },
        });
      }
      await tx.groupLesson.create({
        data: {
          id: `test-feedback-kit-lesson-${lesson.sequence}`,
          groupId: fixture.group.id,
          sequence: lesson.sequence,
          title: lesson.topic,
          materialSnapshot: snapshot,
          revision: 1,
          confirmedAt: new Date(`${lesson.date}T00:00:00.000Z`),
          revisions: {
            create: {
              id: `test-feedback-kit-revision-${lesson.sequence}`,
              revision: 1,
              materialSnapshot: snapshot,
              confirmedAt: new Date(`${lesson.date}T00:00:00.000Z`),
            },
          },
          sessionLinks: {
            create: lesson.codes.map((_, classIndex) => ({
              id: `test-feedback-kit-session-link-${lesson.sequence}-${classIndex + 1}`,
              sessionId: `test-feedback-kit-session-${lesson.sequence}-${classIndex + 1}`,
              syncStatus: "synced",
              comparable: true,
            })),
          },
        },
      });
    }
  });
  console.log("测试班级组安装完成：2 个班、6 名 ACTIVE 学生、2 讲共同课、4 个真实课次");
}

main().finally(() => prisma.$disconnect());
