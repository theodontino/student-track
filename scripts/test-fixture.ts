import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../src/generated/prisma/client";
import { assertSafeTestDatabaseUrl } from "./test-environment";
import { TEST_FIXTURE } from "./test-fixture-data";
import { parseLessonFeedbackMaterial } from "../src/lib/feedback-materials";

export async function seedTestFixture(databaseUrl = process.env.DATABASE_URL) {
  assertSafeTestDatabaseUrl(databaseUrl);
  const adapter = new PrismaLibSql({ url: databaseUrl! });
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.semester.create({ data: TEST_FIXTURE.semester });
    await prisma.class.create({ data: TEST_FIXTURE.class });
    await prisma.class.create({ data: TEST_FIXTURE.classTwo });

    for (const student of TEST_FIXTURE.students) {
      await prisma.student.create({ data: student });
      await prisma.studentClassEnrollment.create({
        data: {
          studentId: student.id,
          semesterId: TEST_FIXTURE.semester.id,
          classId: TEST_FIXTURE.class.id,
        },
      });
    }
    for (const student of TEST_FIXTURE.groupStudents) {
      await prisma.student.create({ data: student });
      await prisma.studentClassEnrollment.create({
        data: { studentId: student.id, semesterId: TEST_FIXTURE.semester.id, classId: TEST_FIXTURE.classTwo.id },
      });
    }

    const logicLabel = await prisma.label.create({
      data: { id: "test-label-1", name: "#逻辑强" },
    });
    const foundationLabel = await prisma.label.create({
      data: { id: "test-label-2", name: "#基础扎实" },
    });
    await prisma.studentLabel.createMany({
      data: [
        { studentId: TEST_FIXTURE.students[0].id, labelId: logicLabel.id },
        { studentId: TEST_FIXTURE.students[0].id, labelId: foundationLabel.id },
      ],
    });

    for (const session of TEST_FIXTURE.sessions) {
      await prisma.classSession.create({
        data: {
          ...session,
          semesterId: TEST_FIXTURE.semester.id,
          classId: TEST_FIXTURE.class.id,
        },
      });
      await prisma.attendance.createMany({
        data: TEST_FIXTURE.students.map((student) => ({
          sessionId: session.id,
          studentId: student.id,
          present: true,
        })),
      });
    }
    await prisma.classSession.create({
      data: { ...TEST_FIXTURE.groupSession, semesterId: TEST_FIXTURE.semester.id, classId: TEST_FIXTURE.classTwo.id },
    });
    await prisma.attendance.createMany({
      data: TEST_FIXTURE.groupStudents.map((student) => ({ sessionId: TEST_FIXTURE.groupSession.id, studentId: student.id, present: true })),
    });

    await prisma.sessionMetric.createMany({
      data: TEST_FIXTURE.students.map((student) => ({
        id: `test-metric-${student.id}`,
        studentId: student.id,
        sessionId: TEST_FIXTURE.sessions[0].id,
        date: TEST_FIXTURE.sessions[0].date,
        scoreA: 3,
        scoreB: 3,
        scoreC: 3,
        scoreD: 5,
        operator: "teacher" as const,
      })),
    });
    await prisma.sessionMetric.createMany({
      data: TEST_FIXTURE.groupStudents.map((student) => ({
        id: `test-metric-${student.id}`,
        studentId: student.id,
        sessionId: TEST_FIXTURE.groupSession.id,
        date: TEST_FIXTURE.groupSession.date,
        scoreA: 4,
        scoreB: 4,
        scoreC: 3,
        scoreD: 5,
        operator: "teacher" as const,
      })),
    });

    const material = parseLessonFeedbackMaterial("课程标题：E2E 共同课\n课堂内容：氧化还原反应", "课后任务：订正出门测");
    const nextMaterial = parseLessonFeedbackMaterial("课程标题：E2E 第二讲\n课堂内容：离子反应", "课后任务：整理笔记");
    await prisma.semester.update({
      where: { id: TEST_FIXTURE.semester.id },
      data: {
        feedbackScriptLibraryName: "E2E 学期公共材料库",
        feedbackScriptLibraryUpdatedAt: new Date("2026-07-08T08:00:00.000Z"),
        feedbackScriptLibraryJson: JSON.stringify({
          version: 2,
          name: "E2E 学期公共材料库",
          warnings: [],
          updatedAt: "2026-07-08T08:00:00.000Z",
          entries: [
            { lessonNumber: 1, topic: "氧化还原反应", groupFeedback: material.groupFeedbackRaw, perfectPrivateFeedback: "", errorPrivateFeedback: "", note: "", material },
            { lessonNumber: 2, topic: "离子反应", groupFeedback: nextMaterial.groupFeedbackRaw, perfectPrivateFeedback: "", errorPrivateFeedback: "", note: "", material: nextMaterial },
          ],
        }),
      },
    });
    await prisma.classGroup.create({
      data: {
        id: TEST_FIXTURE.classGroup.id,
        semesterId: TEST_FIXTURE.semester.id,
        leadClassId: TEST_FIXTURE.class.id,
        name: TEST_FIXTURE.classGroup.name,
        memberships: { create: [{ classId: TEST_FIXTURE.class.id }, { classId: TEST_FIXTURE.classTwo.id }] },
      },
    });
    await prisma.groupLesson.create({
      data: {
        id: TEST_FIXTURE.groupLesson.id,
        groupId: TEST_FIXTURE.classGroup.id,
        title: "E2E 共同课",
        sequence: 1,
        materialSnapshot: JSON.stringify(material),
        revision: 1,
        confirmedAt: new Date("2026-07-08T08:00:00.000Z"),
        revisions: { create: { id: TEST_FIXTURE.groupLesson.revisionId, revision: 1, materialSnapshot: JSON.stringify(material), confirmedAt: new Date("2026-07-08T08:00:00.000Z") } },
        sessionLinks: { create: [
          { sessionId: TEST_FIXTURE.sessions[1].id, syncStatus: "synced", comparable: true },
          { sessionId: TEST_FIXTURE.groupSession.id, syncStatus: "synced", comparable: true },
        ] },
      },
    });

    await prisma.event.create({
      data: {
        id: "test-event-1",
        studentId: TEST_FIXTURE.students[0].id,
        sessionId: TEST_FIXTURE.sessions[0].id,
        type: "测验成绩",
        description: "氧化还原反应测验完成稳定",
        rawText: "E2E 固定事件",
      },
    });
    await prisma.communication.create({
      data: {
        id: "test-communication-1",
        studentId: TEST_FIXTURE.students[0].id,
        sessionId: TEST_FIXTURE.sessions[0].id,
        target: "家长",
        summary: "已沟通近期学习节奏。",
      },
    });

    await prisma.draftRecord.create({
      data: {
        id: TEST_FIXTURE.draft.id,
        rawText: TEST_FIXTURE.draft.rawText,
        sessionCode: TEST_FIXTURE.sessions[1].code,
        studentId: TEST_FIXTURE.students[0].id,
        status: "pending",
        parsedResult: JSON.stringify({
          students: [{
            name: TEST_FIXTURE.students[0].name,
            scores: { A: 5, B: 4, C: 3 },
            events: ["课堂表现积极"],
            communication: null,
            present: true,
          }],
          alert_suggestion: "",
        }),
      },
    });

  } finally {
    await prisma.$disconnect();
  }
}
