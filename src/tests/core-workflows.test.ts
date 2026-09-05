import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateSessionAttendance } from "@/services/attendance-service";
import { submitQuickScores } from "@/services/quick-score-service";
import { processDraftReview } from "@/services/review-service";
import { ServiceError } from "@/services/service-error";
import { createClassSession, deleteClassSession } from "@/services/session-service";
import { ASSISTANT_ROSTER_RAW_TEXT_PREFIX } from "@/lib/classroom-import-source";

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
  const semester = await prisma.semester.create({
    data: {
      name: `测试学期-${suffix}`,
      startDate: "2098-01-01",
      endDate: "2098-12-31",
    },
  });
  semesterId = semester.id;
  const classroom = await prisma.class.create({
    data: { semesterId, code: classCode, name: `测试班-${suffix}` },
  });
  classId = classroom.id;
  const students = await Promise.all([1, 2].map((index) => prisma.student.create({
    data: {
      name: `测试学生${index}-${suffix}`,
      enrollments: { create: { semesterId, classId } },
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
  if (semesterId) await prisma.classSession.deleteMany({ where: { semesterId } });
  if (studentIds.length > 0) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  if (classId) await prisma.class.deleteMany({ where: { id: classId } });
  if (semesterId) await prisma.semester.deleteMany({ where: { id: semesterId } });
  await prisma.label.deleteMany({ where: { name: "AI内部关注：学习信心", students: { none: {} } } });
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
        { studentId: studentIds[0], scoreA: 4.2, scoreB: 4, scoreC: 3, note: "主动回答问题" },
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
    expect(metrics.find((metric) => metric.studentId === studentIds[0])).toMatchObject({
      scoreA: 4.2,
      scoreD: 0,
      operator: "quickScore",
    });
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
              attentionSignals: [{ reason: "learning-confidence", confidence: "high", evidenceSummary: "学生明确表示最近没有信心" }],
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

    const amended = JSON.parse(draft.parsedResult);
    amended.students[0].teacherInterventions = [{
      observedProblem: "答题时漏看了一个条件",
      teacherAction: "",
      outcome: "",
      evidenceText: "",
    }];
    await expect(processDraftReview({ draftId: draft.id, action: "confirm", edits: amended })).resolves.toMatchObject({
      success: true,
      status: "confirmed",
      warnings: expect.arrayContaining(["已更新教师确认后的结构化记录"]),
    });

    await expect(prisma.draftRecord.findUnique({ where: { id: draft.id } })).resolves.toMatchObject({
      status: "confirmed",
    });
    expect(await prisma.event.count({ where: { sessionId, studentId: students[0].id } })).toBe(2);
    await expect(prisma.event.findFirst({
      where: { sessionId, studentId: students[0].id, type: "教师处理" },
    })).resolves.toMatchObject({ description: "观察问题：答题时漏看了一个条件" });
    expect(await prisma.communication.count({ where: { sessionId, studentId: students[0].id } })).toBe(1);
    await expect(prisma.studentLabel.findFirst({ where: { studentId: students[0].id, label: { name: "AI内部关注：学习信心" } }, include: { label: true } })).resolves.toMatchObject({ label: { name: "AI内部关注：学习信心" } });
  });

  it("keeps a partial teacher observation in the existing teacher-handling event", async () => {
    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentIds[0] } });
    const draft = await prisma.draftRecord.create({
      data: {
        rawText: `${student.name} 后半节开始漏看题目条件，老师当场提醒`,
        sessionCode,
        parsedResult: JSON.stringify({
          students: [{
            name: student.name,
            scores: { A: null, B: null, C: null },
            events: [],
            communication: null,
            present: true,
            teacherInterventions: [{
              observedProblem: "后半节开始漏看题目条件",
              teacherAction: "",
              outcome: "",
              evidenceText: "老师当场提醒",
            }],
          }],
          alert_suggestion: "",
        }),
      },
    });
    draftIds.push(draft.id);

    await expect(processDraftReview({ draftId: draft.id, action: "confirm" })).resolves.toMatchObject({
      success: true,
      status: "confirmed",
    });

    await expect(prisma.event.findMany({
      where: { sessionId, studentId: student.id, type: "教师处理" },
      select: { description: true },
    })).resolves.toEqual([{ description: "观察问题：后半节开始漏看题目条件；证据：老师当场提醒" }]);
  });

  it("keeps assistant roster scores and attendance when a STEP draft is confirmed later", async () => {
    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentIds[0] } });
    const assistantDraft = await prisma.draftRecord.create({
      data: {
        rawText: `${ASSISTANT_ROSTER_RAW_TEXT_PREFIX}测试班 2098-01-01 课次 ${sessionCode}`,
        sessionCode,
        status: "confirmed",
        parsedResult: JSON.stringify({ students: [], alert_suggestion: "" }),
      },
    });
    draftIds.push(assistantDraft.id);
    await prisma.sessionMetric.create({
      data: {
        studentId: student.id,
        sessionId,
        date: "2098-01-01",
        scoreA: 5,
        scoreB: 4,
        scoreC: 3,
        scoreD: 5,
        operator: "nlReview",
      },
    });

    const stepDraft = await prisma.draftRecord.create({
      data: {
        rawText: JSON.stringify({
          class: { code: classCode, name: "测试班" },
          stepSessionId: "test-step-session",
          students: [{ studentId: student.studentId, name: student.name }],
        }),
        sessionCode,
        parsedResult: JSON.stringify({
          students: [{
            name: student.name,
            studentId: student.studentId,
            scores: { A: 1, B: 1, C: 1 },
            events: ["题1：独立完成但节奏较慢"],
            communication: null,
            present: false,
          }],
          alert_suggestion: "",
        }),
      },
    });
    draftIds.push(stepDraft.id);

    await expect(processDraftReview({ draftId: stepDraft.id, action: "confirm" })).resolves.toMatchObject({
      success: true,
      status: "confirmed",
      warnings: expect.arrayContaining(["本课次已有助教表；STEP 仅写入教师观察，未改动评分和考勤"]),
    });

    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: student.id, sessionId } },
    })).resolves.toMatchObject({ scoreA: 5, scoreB: 4, scoreC: 3 });
    await expect(prisma.attendance.findUnique({
      where: { sessionId_studentId: { sessionId, studentId: student.id } },
    })).resolves.toMatchObject({ present: true });
    expect(await prisma.event.count({
      where: { sessionId, studentId: student.id, type: { not: "教师处理" } },
    })).toBe(0);
    await expect(prisma.event.findFirst({
      where: { sessionId, studentId: student.id, type: "教师处理" },
    })).resolves.toMatchObject({ description: expect.stringContaining("题1：独立完成但节奏较慢") });
  });

  it("confirms unified intake by stable student ID when the class contains duplicate names", async () => {
    const students = await prisma.student.findMany({
      where: { id: { in: studentIds } },
      orderBy: { studentId: "asc" },
    });
    await prisma.student.update({ where: { id: students[1]!.id }, data: { name: students[0]!.name } });
    const parsedResult = {
      students: [{
        name: students[0]!.name,
        studentId: students[0]!.studentId,
        scores: { A: 4.2, B: null, C: null },
        events: [],
        communication: null,
        present: true,
      }],
      alert_suggestion: "",
    };
    const draft = await prisma.draftRecord.create({
      data: {
        rawText: JSON.stringify({
          class: { code: classCode, name: "统一课后材料" },
          stepSessionId: "feedback-intake:stable-id-test",
          students: parsedResult.students,
        }),
        sessionCode,
        parsedResult: JSON.stringify(parsedResult),
      },
    });
    draftIds.push(draft.id);

    await expect(processDraftReview({ draftId: draft.id, action: "confirm" })).resolves.toMatchObject({
      success: true,
      status: "confirmed",
    });
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: students[0]!.id, sessionId } },
    })).resolves.toMatchObject({
      scoreA: 4.2,
      operator: "nlReview",
    });
    await expect(prisma.sessionMetric.findUnique({
      where: { studentId_sessionId: { studentId: students[1]!.id, sessionId } },
    })).resolves.toBeNull();
  });

  it("validates class selection and refuses to delete a session that already has facts", async () => {
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

    await expect(deleteClassSession({ semesterId, code: created.code })).rejects.toMatchObject({ status: 409 });
    await expect(prisma.classSession.findUnique({ where: { id: created.id } })).resolves.not.toBeNull();
    await expect(prisma.sessionMetric.findUnique({ where: { id: metric.id } })).resolves.not.toBeNull();
    await prisma.classSession.delete({ where: { id: created.id } });
  });

  it("blocks core session writes while the class is in the recycle bin", async () => {
    const blankSession = await prisma.classSession.create({
      data: {
        code: `BLANK-${randomUUID().slice(0, 8)}`,
        semesterId,
        semesterNumber: 2,
        date: "2098-02-03",
        classId,
      },
    });
    const draft = await prisma.draftRecord.create({
      data: { rawText: "合成测试", parsedResult: JSON.stringify({ students: [], alert_suggestion: "" }), sessionCode },
    });
    draftIds.push(draft.id);
    await prisma.class.update({ where: { id: classId }, data: { deletedAt: new Date() } });

    await expect(updateSessionAttendance(sessionId, [{ studentId: studentIds[0], present: false }])).rejects.toMatchObject({ status: 409 });
    await expect(processDraftReview({ draftId: draft.id, action: "reject" })).rejects.toMatchObject({ status: 409 });
    await expect(deleteClassSession({ semesterId, code: blankSession.code })).rejects.toMatchObject({ status: 409 });
    await expect(prisma.classSession.findUnique({ where: { id: blankSession.id } })).resolves.not.toBeNull();
  });

  it("excludes inactive students from a newly created attendance roster without changing history", async () => {
    await prisma.studentClassEnrollment.update({
      where: { studentId_semesterId: { studentId: studentIds[1], semesterId } },
      data: { rosterStatus: "INACTIVE", statusEffectiveAt: new Date() },
    });
    const historicalAttendance = await prisma.attendance.count({
      where: { studentId: studentIds[1], sessionId },
    });
    const created = await createClassSession({
      semesterId,
      classCode,
      date: "2098-02-02",
    });
    expect(created.studentCount).toBe(1);
    expect(await prisma.attendance.findMany({
      where: { sessionId: created.id },
      select: { studentId: true },
    })).toEqual([{ studentId: studentIds[0] }]);
    expect(await prisma.attendance.count({
      where: { studentId: studentIds[1], sessionId },
    })).toBe(historicalAttendance);
    await expect(deleteClassSession({ semesterId, code: created.code })).rejects.toMatchObject({ status: 409 });
    await prisma.classSession.delete({ where: { id: created.id } });
  });
});
