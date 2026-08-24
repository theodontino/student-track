import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../src/generated/prisma/client";
import { parseLessonFeedbackMaterial } from "../src/lib/feedback-materials";
import { assertSafeTestDatabaseUrl } from "./test-environment";
import { COURSE_CYCLE_FIXTURE } from "./course-cycle-test-fixture-data";

function materialFor(sequence: number, topic: string) {
  const groupFeedback = `第${sequence}讲《${topic}》：本讲梳理${topic}的核心概念、判断方法与典型应用。`;
  const material = parseLessonFeedbackMaterial(groupFeedback, "统一测评只用于核对本讲知识结构，个人表现以学生证据为准。");
  return {
    ...material,
    lessonTitle: topic,
    scriptLessonNumber: sequence,
    semesterScriptSource: {
      lessonNumber: sequence,
      libraryUpdatedAt: "2026-08-25T00:00:00.000Z",
    },
  };
}

export async function seedCourseCycleFixture(databaseUrl = process.env.DATABASE_URL) {
  assertSafeTestDatabaseUrl(databaseUrl);
  const adapter = new PrismaLibSql({ url: databaseUrl! });
  const prisma = new PrismaClient({ adapter });
  const fixture = COURSE_CYCLE_FIXTURE;

  try {
    const libraryEntries = fixture.lessons.map((lesson) => ({
      lessonNumber: lesson.sequence,
      topic: lesson.topic,
      groupFeedback: `第${lesson.sequence}讲《${lesson.topic}》课程公共反馈`,
      perfectPrivateFeedback: "本次个人证据显示已完成目标。",
      errorPrivateFeedback: "本次个人证据显示仍需订正。",
      note: "固定合成课程周期测试材料",
      material: materialFor(lesson.sequence, lesson.topic),
    }));
    await prisma.semester.create({
      data: {
        ...fixture.semester,
        feedbackScriptLibraryName: "E2E课程公共材料库",
        feedbackScriptLibraryJson: JSON.stringify({ version: 2, name: "E2E课程公共材料库", entries: libraryEntries, warnings: [] }),
        feedbackScriptLibraryUpdatedAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    });
    await prisma.class.createMany({ data: fixture.classes.map((item) => ({ ...item })) });

    for (const student of fixture.students) {
      await prisma.student.create({
        data: { id: student.id, name: student.name, studentId: student.studentId, gender: student.gender },
      });
      await prisma.studentClassEnrollment.create({
        data: {
          studentId: student.id,
          semesterId: fixture.semester.id,
          classId: fixture.classes[student.classIndex].id,
        },
      });
    }

    await prisma.classGroup.create({
      data: {
        id: fixture.classGroup.id,
        semesterId: fixture.semester.id,
        leadClassId: fixture.classes[0].id,
        name: fixture.classGroup.name,
        memberships: { create: fixture.classes.map((item) => ({ classId: item.id })) },
      },
    });

    for (const lesson of fixture.lessons) {
      const material = materialFor(lesson.sequence, lesson.topic);
      for (const session of lesson.sessions) {
        await prisma.classSession.create({
          data: {
            id: session.id,
            code: session.code,
            date: lesson.date,
            semesterNumber: session.semesterNumber,
            semesterId: fixture.semester.id,
            classId: fixture.classes[session.classIndex].id,
          },
        });
        const students = fixture.students.filter((student) => student.classIndex === session.classIndex);
        await prisma.attendance.createMany({
          data: students.map((student, studentIndex) => ({
            sessionId: session.id,
            studentId: student.id,
            present: !(lesson.sequence === 3 && studentIndex === 2),
          })),
        });
        await prisma.sessionMetric.createMany({
          data: students.map((student, studentIndex) => ({
            id: `test-cycle-metric-${lesson.sequence}-${student.id}`,
            studentId: student.id,
            sessionId: session.id,
            date: lesson.date,
            scoreA: Math.min(5, 2 + ((lesson.sequence + studentIndex) % 4)),
            scoreB: Math.min(5, 3 + ((lesson.sequence + studentIndex) % 3)),
            scoreC: Math.min(5, 2 + ((lesson.sequence * 2 + studentIndex) % 4)),
            scoreD: lesson.sequence === 3 && studentIndex === 2 ? 4 : 5,
            operator: "teacher",
          })),
        });
      }

      await prisma.groupLesson.create({
        data: {
          id: lesson.id,
          groupId: fixture.classGroup.id,
          title: lesson.topic,
          sequence: lesson.sequence,
          materialSnapshot: JSON.stringify(material),
          revision: 1,
          confirmedAt: new Date(`${lesson.date}T08:00:00.000Z`),
          revisions: {
            create: {
              id: lesson.revisionId,
              revision: 1,
              materialSnapshot: JSON.stringify(material),
              confirmedAt: new Date(`${lesson.date}T08:00:00.000Z`),
            },
          },
          sessionLinks: {
            create: lesson.sessions.map((session) => ({
              sessionId: session.id,
              syncStatus: "synced",
              comparable: true,
            })),
          },
        },
      });
    }

    for (const student of fixture.students) {
      const classIndex = student.classIndex;
      const lessonTwoSession = fixture.lessons[1].sessions[classIndex];
      const lessonFiveSession = fixture.lessons[4].sessions[classIndex];
      await prisma.event.createMany({
        data: [
          {
            id: `test-cycle-event-early-${student.id}`,
            studentId: student.id,
            sessionId: lessonTwoSession.id,
            type: "课堂表现",
            description: `${student.name}能够按步骤完成基础判断`,
            rawText: "固定合成课程早期事件",
          },
          {
            id: `test-cycle-event-late-${student.id}`,
            studentId: student.id,
            sessionId: lessonFiveSession.id,
            type: "测验成绩",
            description: `${student.name}在综合应用中能解释主要步骤`,
            rawText: "固定合成课程后期事件",
          },
        ],
      });
    }

    await prisma.communication.create({
      data: {
        id: "test-cycle-communication",
        studentId: fixture.students[0].id,
        sessionId: fixture.lessons[2].sessions[0].id,
        target: "家长",
        summary: "已沟通阶段学习节奏，后续继续观察概念迁移。",
        occurredAt: fixture.lessons[2].date,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
