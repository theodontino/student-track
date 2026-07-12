import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../src/generated/prisma/client";
import { assertSafeTestDatabaseUrl } from "./test-environment";
import { TEST_FIXTURE } from "./test-fixture-data";

export async function seedTestFixture(databaseUrl = process.env.DATABASE_URL) {
  assertSafeTestDatabaseUrl(databaseUrl);
  const adapter = new PrismaLibSql({ url: databaseUrl! });
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.class.create({ data: TEST_FIXTURE.class });
    await prisma.semester.create({ data: TEST_FIXTURE.semester });

    for (const student of TEST_FIXTURE.students) {
      await prisma.student.create({ data: { ...student, classId: TEST_FIXTURE.class.id } });
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

    await prisma.workHistory.create({
      data: {
        id: TEST_FIXTURE.feedbackHistory.id,
        module: "feedback",
        key: TEST_FIXTURE.sessions[0].code,
        title: TEST_FIXTURE.feedbackHistory.title,
        state: JSON.stringify({
          kind: "batch",
          semesterId: TEST_FIXTURE.semester.id,
          sessionCode: TEST_FIXTURE.sessions[0].code,
          className: TEST_FIXTURE.class.name,
          students: TEST_FIXTURE.students.map((student) => ({
            id: student.id,
            name: student.name,
            labels: student.id === TEST_FIXTURE.students[0].id ? ["#逻辑强", "#基础扎实"] : [],
            feedback: `历史恢复反馈：${student.name}表现稳定。`,
          })),
          total: TEST_FIXTURE.students.length,
        }),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
