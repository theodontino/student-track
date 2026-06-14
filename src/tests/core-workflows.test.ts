import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateSessionAttendance } from "@/services/attendance-service";
import { submitQuickScores } from "@/services/quick-score-service";
import { processDraftReview } from "@/services/review-service";
import { ServiceError } from "@/services/service-error";
import { createClassSession, deleteClassSession } from "@/services/session-service";

let classId = "";
let classCode = "";
let semesterId = "";
let sessionId = "";
let sessionCode = "";
let studentIds: string[] = [];
let draftIds: string[] = [];

beforeEach(async () => {
  const suffix = randomUUID().slice(0, 8);
  classCode = `TEST-${suffix}`;
  const classroom = await prisma.class.create({
    data: { code: classCode, name: `测试班-${suffix}` },
  });
  classId = classroom.id;
  const semester = await prisma.semester.create({
    data: {
      name: `测试学期-${suffix}`,
      startDate: "2098-01-01",
      endDate: "2098-12-31",
    },
  });
  semesterId = semester.id;
  const students = await Promise.all([1, 2].map((index) => prisma.student.create({
    data: {
      name: `测试学生${index}-${suffix}`,
      classId,
      studentId: `TEST-${suffix}-${index}`,
      gender: index === 1 ? "男" : "女",
    },
  })));
  studentIds = students.map((student) => student.id);
  const session = await prisma.classSession.create({
    data: {
      code: `FIXTURE-${suffix}`,
      semesterId,
      semesterNumber: 1,
      date: "2098-01-01",
      classId,
    },
  });
  sessionId = session.id;
  sessionCode = session.code;
  await prisma.attendance.createMany({
    data: studentIds.map((studentId) => ({ sessionId, studentId, present: true })),
  });
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (studentIds.length > 0) {
    await prisma.systemLog.deleteMany({ where: { targetId: { in: studentIds } } });
    await prisma.sessionMetricHistory.deleteMany({ where: { studentId: { in: studentIds } } });
  }
  if (draftIds.length > 0) await prisma.draftRecord.deleteMany({ where: { id: { in: draftIds } } });
  if (semesterId) await prisma.semester.deleteMany({ where: { id: semesterId } });
  if (studentIds.length > 0) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  if (classId) await prisma.class.deleteMany({ where: { id: classId } });
  classId = "";
  classCode = "";
  semesterId = "";
  sessionId = "";
  sessionCode = "";
  studentIds = [];
  draftIds = [];
});

describe("core transactional workflows", () => {
  it("rolls back an entire quick-score submission when a later score is invalid", async () => {
    await expect(submitQuickScores({
      sessionCode,
      scores: [
        { studentId: studentIds[0], scoreA: 5, scoreB: 4, scoreC: 3, note: "不应保留" },
        { studentId: studentIds[1], scoreA: Number.NaN, scoreB: 4, scoreC: 3 },
      ],
    })).rejects.toMatchObject({ status: 400 });

    expect(await prisma.sessionMetric.count({ where: { sessionId } })).toBe(0);
    expect(await prisma.event.count({ where: { sessionId } })).toBe(0);
    expect(await prisma.sessionMetricHistory.count({ where: { studentId: { in: studentIds } } })).toBe(0);
  });

  it("writes scores, notes, attendance and D together and keeps note submission idempotent", async () => {
    const input = {
      sessionCode,
      scores: [
        { studentId: studentIds[0], scoreA: 5, scoreB: 4, scoreC: 3, note: "主动回答问题" },
        { studentId: studentIds[1], scoreA: 2, scoreB: 3, scoreC: 4 },
      ],
      attendances: [
        { studentId: studentIds[0], present: false },
        { studentId: studentIds[1], present: true },
      ],
    };
    await expect(submitQuickScores(input)).resolves.toMatchObject({ count: 2, attUpdated: 2 });
    await expect(submitQuickScores(input)).resolves.toMatchObject({ count: 2, attUpdated: 2 });

    const metrics = await prisma.sessionMetric.findMany({
      where: { sessionId },
      orderBy: { studentId: "asc" },
    });
    expect(metrics).toHaveLength(2);
    expect(metrics.find((metric) => metric.studentId === studentIds[0])?.scoreD).toBe(0);
    expect(metrics.find((metric) => metric.studentId === studentIds[1])?.scoreD).toBe(5);
    expect(await prisma.event.count({ where: { sessionId, description: "主动回答问题" } })).toBe(1);
  });

  it("upserts attendance for a student missing from the initial session roster", async () => {
    await prisma.attendance.delete({
      where: { sessionId_studentId: { sessionId, studentId: studentIds[0] } },
    });
    await expect(updateSessionAttendance(sessionId, [
      { studentId: studentIds[0], present: false },
    ])).resolves.toEqual({ success: true });

    await expect(prisma.attendance.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: studentIds[0] } },
    })).resolves.toMatchObject({ present: false });
  });

  it("confirms a draft once and rejects a repeated confirmation", async () => {
    const students = await prisma.student.findMany({
      where: { id: { in: studentIds } },
      orderBy: { studentId: "asc" },
    });
    const draft = await prisma.draftRecord.create({
      data: {
        rawText: `${students[0].name} 表现积极`,
        sessionCode,
        parsedResult: JSON.stringify({
          students: [
            {
              name: students[0].name,
              scores: { A: 5, B: 4, C: null },
              events: ["测验进步"],
              communication: { type: "家长微信", summary: "已同步学习情况" },
              present: false,
            },
            {
              name: students[1].name,
              scores: { A: null, B: null, C: null },
              events: [],
              communication: null,
              present: true,
            },
          ],
          alert_suggestion: "",
        }),
      },
    });
    draftIds.push(draft.id);

    await expect(processDraftReview({ draftId: draft.id, action: "confirm" })).resolves.toMatchObject({
      success: true,
      status: "confirmed",
    });
    await expect(processDraftReview({ draftId: draft.id, action: "confirm" })).rejects.toMatchObject({
      status: 409,
    });

    await expect(prisma.draftRecord.findUnique({ where: { id: draft.id } })).resolves.toMatchObject({
      status: "confirmed",
    });
    expect(await prisma.event.count({ where: { sessionId, studentId: students[0].id } })).toBe(1);
    expect(await prisma.communication.count({ where: { sessionId, studentId: students[0].id } })).toBe(1);
  });

  it("validates class selection and archives metrics before deleting a session", async () => {
    await expect(createClassSession({
      semesterId,
      classCode: "NO-SUCH-CLASS",
      date: "2098-02-01",
    })).rejects.toBeInstanceOf(ServiceError);

    const created = await createClassSession({ semesterId, classCode, date: "2098-02-01" });
    expect(created.studentCount).toBe(2);
    expect(await prisma.attendance.count({ where: { sessionId: created.id } })).toBe(2);
    const metric = await prisma.sessionMetric.create({
      data: {
        studentId: studentIds[0],
        sessionId: created.id,
        date: created.date,
        scoreA: 4,
        scoreB: 4,
        scoreC: 4,
        scoreD: 5,
        operator: "teacher",
      },
    });

    await expect(deleteClassSession({ semesterId, code: created.code })).resolves.toEqual({ success: true });
    await expect(prisma.classSession.findUnique({ where: { id: created.id } })).resolves.toBeNull();
    await expect(prisma.sessionMetricHistory.findFirst({
      where: { metricId: metric.id },
    })).resolves.toMatchObject({ changeType: "delete" });
  });
});
