import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { buildFeedbackContext } from "@/services/feedback-context-service";

let classId = "";
let semesterId = "";
let studentIds: string[] = [];
let labelName = "";
let internalLabelName = "";
let currentSessionCode = "";
let currentSessionId = "";

beforeEach(async () => {
  const suffix = randomUUID().slice(0, 8);
  labelName = `#反馈上下文-${suffix}`;
  internalLabelName = `AI内部关注：测试-${suffix}`;
  const semester = await prisma.semester.create({
    data: { name: `上下文测试学期-${suffix}`, startDate: "2099-01-01", endDate: "2099-12-31" },
  });
  semesterId = semester.id;
  const classroom = await prisma.class.create({
    data: { semesterId, code: `CTX-${suffix}`, name: `上下文测试班-${suffix}` },
  });
  classId = classroom.id;
  const student = await prisma.student.create({
    data: { name: `上下文学生-${suffix}`, studentId: `CTX-STU-${suffix}`, gender: "女", enrollments: { create: { semesterId, classId } } },
  });
  const studentWithoutHistory = await prisma.student.create({
    data: { name: `无历史学生-${suffix}`, studentId: `CTX-NO-${suffix}`, gender: "男", enrollments: { create: { semesterId, classId } } },
  });
  studentIds = [student.id, studentWithoutHistory.id];
  const label = await prisma.label.create({ data: { name: labelName } });
  const internalLabel = await prisma.label.create({ data: { name: internalLabelName } });
  await prisma.studentLabel.create({ data: { studentId: student.id, labelId: label.id } });
  await prisma.studentLabel.create({ data: { studentId: student.id, labelId: internalLabel.id } });

  const previousSession = await prisma.classSession.create({
    data: { code: `CTX${suffix}01`, semesterId, semesterNumber: 1, date: "2099-03-01", classId },
  });
  const currentSession = await prisma.classSession.create({
    data: { code: `CTX${suffix}02`, semesterId, semesterNumber: 2, date: "2099-03-08", classId },
  });
  currentSessionCode = currentSession.code;
  currentSessionId = currentSession.id;

  await prisma.sessionMetric.createMany({
    data: [
      {
        studentId: student.id,
        sessionId: previousSession.id,
        date: previousSession.date,
        scoreA: 3,
        scoreB: 4,
        scoreC: 3,
        scoreD: 5,
        operator: "teacher",
      },
      {
        studentId: student.id,
        sessionId: currentSession.id,
        date: currentSession.date,
        scoreA: 5,
        scoreB: 4,
        scoreC: 4,
        scoreD: 5,
        operator: "teacher",
      },
    ],
  });
  await prisma.attendance.create({ data: { sessionId: currentSession.id, studentId: student.id, present: true } });
  await prisma.event.create({
    data: {
      sessionId: currentSession.id,
      studentId: student.id,
      type: "课堂表现",
      description: "主动订正错题",
      rawText: "主动订正错题",
    },
  });
  await prisma.communication.create({
    data: {
      sessionId: previousSession.id,
      studentId: student.id,
      target: "母亲",
      summary: "[企微长期沟通] 家长希望反馈时多强调进步和复盘方法。",
    },
  });
});

afterEach(async () => {
  await prisma.label.deleteMany({ where: { name: { in: [labelName, internalLabelName] } } });
  if (semesterId) await prisma.classSession.deleteMany({ where: { semesterId } });
  if (studentIds.length > 0) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  if (classId) await prisma.class.deleteMany({ where: { id: classId } });
  if (semesterId) await prisma.semester.deleteMany({ where: { id: semesterId } });
  classId = "";
  semesterId = "";
  studentIds = [];
  labelName = "";
  internalLabelName = "";
  currentSessionCode = "";
  currentSessionId = "";
});

describe("buildFeedbackContext", () => {
  it("combines current session, trends, communications and labels for feedback generation", async () => {
    await prisma.communication.create({
      data: {
        sessionId: currentSessionId,
        studentId: studentIds[0]!,
        target: "母亲",
        occurredAt: "2099-03-07至2099-03-08",
        summary: "家长跨日沟通需要保留学习进度的时间范围。",
      },
    });
    const result = await buildFeedbackContext(prisma, currentSessionCode);
    const student = result.students.find((item) => item.id === studentIds[0]);

    expect(result.total).toBe(2);
    expect(student?.labels).toContain(labelName);
    expect(student?.labels).not.toContain(internalLabelName);
    expect(student?.preview.today.join("；")).toContain("主动订正错题");
    expect(student?.preview.trend).toContain("A3/B4/C3/D5");
    expect(student?.preview.communications.join("；")).toContain("家长希望反馈时多强调进步");
    expect(student?.promptContext).toContain(labelName);
    expect(student?.promptContext).not.toContain(internalLabelName);
    expect(student?.promptContext).toContain("近期家校沟通");
    expect(student?.rawMetrics.communications.find((item) => item.summary.includes("跨日沟通"))).toMatchObject({
      occurredAt: "2099-03-07至2099-03-08",
    });
    expect(student?.promptContext).toContain("昨天至今天");
    expect(student?.promptContext).not.toContain("2099-03-07");
  });

  it("keeps students without historical records in the context without throwing", async () => {
    const result = await buildFeedbackContext(prisma, currentSessionCode);
    const student = result.students.find((item) => item.id === studentIds[1]);

    expect(student).toBeTruthy();
    expect(student?.preview.today.join("；")).toContain("无记录");
    expect(student?.preview.trend).toBe("暂无近期评分趋势");
    expect(student?.preview.communications).toEqual([]);
  });

  it("keeps the preview compact while giving the model more communication history", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, index) => prisma.communication.create({
      data: {
        studentId: studentIds[0],
        sessionId: currentSessionId,
        target: "母亲",
        summary: `近期学习沟通-${index + 1}`,
      },
    })));
    await prisma.communication.create({
      data: {
        studentId: studentIds[0],
        sessionId: currentSessionId,
        target: "母亲",
        summary: "收到老师，周日上午十点正常上课。",
      },
    });

    const result = await buildFeedbackContext(prisma, currentSessionCode);
    const student = result.students.find((item) => item.id === studentIds[0]);

    expect(student?.preview.communications).toHaveLength(3);
    expect(student?.rawMetrics.communications).toHaveLength(6);
    expect(student?.promptContext).toContain("家长希望反馈时多强调进步和复盘方法");
    expect(student?.promptContext).not.toContain("周日上午十点");
  });

  it("compares the latest two evaluations with both the personal semester baseline and same-session class means", async () => {
    const suffix = randomUUID().slice(0, 8);
    const peers = await Promise.all([1, 2].map((index) => prisma.student.create({
      data: {
        name: `同期学生${index}-${suffix}`,
        studentId: `CTX-PEER-${index}-${suffix}`,
        gender: "男",
        enrollments: { create: { semesterId, classId } },
      },
    })));
    studentIds.push(...peers.map((student) => student.id));
    const sessions = await prisma.classSession.findMany({
      where: { semesterId, classId },
      orderBy: { semesterNumber: "asc" },
    });
    const earlier = await prisma.classSession.create({
      data: {
        code: `CTX${suffix}00`,
        semesterId,
        semesterNumber: 0,
        date: "2099-02-22",
        classId,
      },
    });
    await prisma.sessionMetric.createMany({
      data: [
        {
          studentId: studentIds[0],
          sessionId: earlier.id,
          date: earlier.date,
          scoreA: 2,
          scoreB: 3,
          scoreC: 3,
          scoreD: 5,
          operator: "teacher",
        },
        ...peers.flatMap((peer) => [
          {
            studentId: peer.id,
            sessionId: earlier.id,
            date: earlier.date,
            scoreA: 2,
            scoreB: 3,
            scoreC: 3,
            scoreD: 5,
            operator: "teacher" as const,
          },
          {
            studentId: peer.id,
            sessionId: sessions[0].id,
            date: sessions[0].date,
            scoreA: 2,
            scoreB: 3,
            scoreC: 3,
            scoreD: 5,
            operator: "teacher" as const,
          },
          {
            studentId: peer.id,
            sessionId: sessions[1].id,
            date: sessions[1].date,
            scoreA: 4,
            scoreB: 3,
            scoreC: 3,
            scoreD: 5,
            operator: "teacher" as const,
          },
        ]),
      ],
    });

    const result = await buildFeedbackContext(prisma, currentSessionCode);
    const student = result.students.find((item) => item.id === studentIds[0]);
    expect(student?.rawMetrics.performanceBaseline).toMatchObject({
      semesterValidCount: 3,
      recentValidCount: 2,
      recentAverageA: 4,
      classComparisonCount: 2,
    });
    expect(student?.rawMetrics.performanceBaseline.personalDifference).toBeCloseTo(0.67, 2);
    expect(student?.rawMetrics.performanceBaseline.classAverageDifference).toBeCloseTo(0.67, 2);
    expect(student?.promptContext).toContain("较个人本学期A均分");
    expect(student?.promptContext).toContain("同期班级A均值");
    expect(student?.promptContext).not.toContain("前两次");
  });
});
