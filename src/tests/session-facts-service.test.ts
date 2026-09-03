import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

const backupMocks = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn() }));
vi.mock("@/services/database-backup-service", () => ({
  createDatabaseBackup: backupMocks.create,
  verifyDatabaseBackup: backupMocks.verify,
}));

import { clearSessionFacts, getSessionFactsImpact } from "@/services/session-facts-service";

const marker = "VITEST-SESSION-FACTS-CLEAR";

afterEach(async () => {
  backupMocks.create.mockReset();
  backupMocks.verify.mockReset();
  const semesters = await prisma.semester.findMany({ where: { name: marker }, select: { id: true } });
  const semesterIds = semesters.map((item) => item.id);
  if (semesterIds.length) {
    await prisma.feedbackPlan.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.classSession.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.studentClassEnrollment.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.class.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.semester.deleteMany({ where: { id: { in: semesterIds } } });
  }
  await prisma.student.deleteMany({ where: { studentId: marker } });
});

describe("session facts service", () => {
  it("clears only current lesson facts and intake drafts while preserving plans and communication", async () => {
    backupMocks.create.mockResolvedValue({ backupPath: "/tmp/test-backup.db", manifest: { createdAt: "2099-01-01T00:00:00.000Z" } });
    backupMocks.verify.mockResolvedValue({});
    const semester = await prisma.semester.create({ data: { name: marker, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const klass = await prisma.class.create({ data: { semesterId: semester.id, code: marker, name: "事实清理班" } });
    const student = await prisma.student.create({ data: { name: "事实清理学生", studentId: marker, gender: "女", enrollments: { create: { semesterId: semester.id, classId: klass.id } } } });
    const session = await prisma.classSession.create({ data: { semesterId: semester.id, classId: klass.id, code: "2099010198", date: "2099-01-01", semesterNumber: 1, commonMaterialSnapshot: "{\"lessonTitle\":\"保留材料\"}" } });
    const metric = await prisma.sessionMetric.create({ data: { sessionId: session.id, studentId: student.id, date: session.date, scoreA: 5, scoreB: 4, scoreC: 3, scoreD: 5, operator: "teacher" } });
    await prisma.attendance.create({ data: { sessionId: session.id, studentId: student.id, present: true } });
    await prisma.event.create({ data: { sessionId: session.id, studentId: student.id, type: "教师处理", description: "已在课堂处理", rawText: "合成测试" } });
    const communication = await prisma.communication.create({ data: { sessionId: session.id, studentId: student.id, target: "家长", summary: "应保留的沟通" } });
    const plan = await prisma.feedbackPlan.create({ data: { type: "event_micro", displayName: "应保留计划", outputRequirement: "测试", status: "draft", semesterId: semester.id, classId: klass.id, sessionId: session.id, inputFingerprint: marker, inputSnapshot: "{}" } });
    const run = await prisma.feedbackIntakeRun.create({ data: { sessionCode: session.code, sourceFingerprint: marker, status: "applied" } });
    const directDraft = await prisma.draftRecord.create({ data: { rawText: "新录入草稿", parsedResult: "{}", intakeRunId: run.id, sessionCode: session.code } });
    const legacyDraft = await prisma.draftRecord.create({ data: { rawText: `legacy feedback-intake:${run.id}`, parsedResult: "{}", sessionCode: session.code } });

    await expect(getSessionFactsImpact(session.id)).resolves.toMatchObject({ metricCount: 1, attendanceCount: 1, eventCount: 1, teacherHandlingCount: 1, intakeRunCount: 1, draftCount: 2 });
    const result = await clearSessionFacts(session.id);
    expect(result).toMatchObject({ success: true, backup: { verified: true }, cleared: { metrics: 1, attendances: 1, events: 1, intakeRuns: 1, drafts: 2 } });
    expect(backupMocks.create).toHaveBeenCalledTimes(1);
    expect(backupMocks.verify).toHaveBeenCalledWith("/tmp/test-backup.db");
    await expect(prisma.sessionMetric.findUnique({ where: { id: metric.id } })).resolves.toBeNull();
    await expect(prisma.sessionMetricHistory.findFirst({ where: { metricId: metric.id, changeType: "clear" } })).resolves.toMatchObject({ sessionId: session.id, scoreA: 5 });
    await expect(prisma.draftRecord.findMany({ where: { id: { in: [directDraft.id, legacyDraft.id] } } })).resolves.toHaveLength(0);
    await expect(prisma.feedbackIntakeRun.findUnique({ where: { id: run.id } })).resolves.toBeNull();
    await expect(prisma.communication.findUnique({ where: { id: communication.id } })).resolves.toMatchObject({ summary: "应保留的沟通" });
    await expect(prisma.feedbackPlan.findUnique({ where: { id: plan.id } })).resolves.toMatchObject({ displayName: "应保留计划" });
    await expect(prisma.classSession.findUnique({ where: { id: session.id } })).resolves.toMatchObject({ commonMaterialSnapshot: "{\"lessonTitle\":\"保留材料\"}" });
  });

  it("does not clear anything when the verified backup cannot be created", async () => {
    backupMocks.create.mockRejectedValue(new Error("backup failed"));
    const semester = await prisma.semester.create({ data: { name: marker, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const klass = await prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-FAIL` } });
    const student = await prisma.student.create({ data: { name: "备份失败学生", studentId: marker, gender: "男" } });
    const session = await prisma.classSession.create({ data: { semesterId: semester.id, classId: klass.id, code: "2099010197", date: "2099-01-01", semesterNumber: 1 } });
    await prisma.event.create({ data: { sessionId: session.id, studentId: student.id, type: "课堂表现", description: "必须保留", rawText: "合成测试" } });

    await expect(clearSessionFacts(session.id)).rejects.toThrow("backup failed");
    await expect(prisma.event.count({ where: { sessionId: session.id } })).resolves.toBe(1);
  });
});
