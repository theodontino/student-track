import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

const backupMocks = vi.hoisted(() => ({ create: vi.fn(), verify: vi.fn() }));
vi.mock("@/services/database-backup-service", () => ({
  createDatabaseBackup: backupMocks.create,
  verifyDatabaseBackup: backupMocks.verify,
}));

import {
  assertClassAvailable,
  assertFeedbackBatchAvailable,
  moveScopeToRecycleBin,
  purgeExpiredRecycleBin,
  restoreScope,
} from "@/services/academic-scope-recycle-service";

const marker = "VITEST-RECYCLE-SCOPE";

afterEach(async () => {
  delete process.env.STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT;
  backupMocks.create.mockReset();
  backupMocks.verify.mockReset();
  await prisma.draftRecord.deleteMany({ where: { rawText: { startsWith: marker } } });
  const semesters = await prisma.semester.findMany({ where: { name: { startsWith: marker } }, select: { id: true } });
  const semesterIds = semesters.map((item) => item.id);
  if (semesterIds.length) {
    await prisma.feedbackPlan.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.feedbackPlanBatch.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.classSession.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.studentClassEnrollment.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.class.deleteMany({ where: { semesterId: { in: semesterIds } } });
    await prisma.semester.deleteMany({ where: { id: { in: semesterIds } } });
  }
  await prisma.student.deleteMany({ where: { studentId: { startsWith: marker } } });
});

describe("academic scope recycle service", () => {
  it("keeps the original recovery deadline when delete is retried", async () => {
    const semester = await prisma.semester.create({ data: { name: `${marker}-IDEMPOTENT`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const klass = await prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-IDEMPOTENT` } });

    const first = await moveScopeToRecycleBin("class", klass.id);
    const repeated = await moveScopeToRecycleBin("class", klass.id);

    expect(repeated.deletedAt).toBe(first.deletedAt);
    expect(repeated.purgeAt).toBe(first.purgeAt);
  });

  it("makes a whole multi-class plan unavailable and restores it without changing archive state", async () => {
    const semester = await prisma.semester.create({ data: { name: marker, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const [first, second] = await Promise.all([
      prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-A` } }),
      prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-B` } }),
    ]);
    const batch = await prisma.feedbackPlanBatch.create({ data: { requestKey: marker, semesterId: semester.id, type: "event_micro", outputRequirement: "测试", status: "running" } });
    await prisma.feedbackPlan.createMany({ data: [
      { type: "event_micro", outputRequirement: "测试", status: "generating", semesterId: semester.id, classId: first.id, inputFingerprint: `${marker}-A`, batchId: batch.id, batchOrder: 1 },
      { type: "event_micro", outputRequirement: "测试", status: "approved", semesterId: semester.id, classId: second.id, inputFingerprint: `${marker}-B`, batchId: batch.id, batchOrder: 2, archivedAt: new Date("2099-01-02") },
    ] });

    await moveScopeToRecycleBin("class", first.id);
    await expect(assertClassAvailable(first.id)).rejects.toMatchObject({ status: 409, code: "scope_in_recycle_bin" });
    await expect(assertFeedbackBatchAvailable(batch.id)).rejects.toMatchObject({ status: 409, code: "scope_in_recycle_bin" });
    await expect(prisma.feedbackPlanBatch.findUnique({ where: { id: batch.id } })).resolves.toMatchObject({ status: "pause_requested", archivedAt: null });
    const archivedBeforeRestore = await prisma.feedbackPlan.findFirst({ where: { batchId: batch.id, classId: second.id }, select: { archivedAt: true } });

    await restoreScope("class", first.id);
    await expect(assertFeedbackBatchAvailable(batch.id)).resolves.toMatchObject({ id: batch.id });
    await expect(prisma.feedbackPlan.findFirst({ where: { batchId: batch.id, classId: second.id }, select: { archivedAt: true } })).resolves.toEqual(archivedBeforeRestore);
  });

  it("restoring a semester does not restore a class deleted independently", async () => {
    const semester = await prisma.semester.create({ data: { name: `${marker}-PARENT`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const klass = await prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-PARENT` } });
    await moveScopeToRecycleBin("class", klass.id);
    await moveScopeToRecycleBin("semester", semester.id);
    await restoreScope("semester", semester.id);
    await expect(prisma.class.findUnique({ where: { id: klass.id }, select: { deletedAt: true } })).resolves.toEqual({ deletedAt: expect.any(Date) });
    await expect(assertClassAvailable(klass.id)).rejects.toMatchObject({ status: 409 });
  });

  it("keeps expired data when the purge backup fails", async () => {
    backupMocks.create.mockRejectedValue(new Error("backup failed"));
    const semester = await prisma.semester.create({ data: { name: `${marker}-EXPIRED`, startDate: "2099-01-01", endDate: "2099-12-31", deletedAt: new Date("2098-01-01") } });

    await expect(purgeExpiredRecycleBin({ now: new Date("2099-01-01") })).rejects.toThrow("backup failed");
    await expect(prisma.semester.findUnique({ where: { id: semester.id } })).resolves.not.toBeNull();
  });

  it("keeps directly bound drafts while a recycled class is still within 30 days", async () => {
    const semester = await prisma.semester.create({ data: { name: `${marker}-NOT-DUE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const klass = await prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-NOT-DUE`, deletedAt: new Date("2098-12-20") } });
    const session = await prisma.classSession.create({ data: { semesterId: semester.id, classId: klass.id, code: "2099010194", date: "2099-01-01", semesterNumber: 1 } });
    const draft = await prisma.draftRecord.create({ data: { rawText: `${marker}-NOT-DUE-DRAFT`, parsedResult: "{}", sessionCode: session.code, kind: "correction" } });

    await expect(purgeExpiredRecycleBin({ now: new Date("2099-01-01") })).resolves.toEqual({ purgedSemesters: 0, purgedClasses: 0, backup: null });
    await expect(prisma.draftRecord.findUnique({ where: { id: draft.id } })).resolves.not.toBeNull();
    expect(backupMocks.create).not.toHaveBeenCalled();
  });

  it("purges the entire affected batch while preserving the other class facts", async () => {
    process.env.STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT = "/tmp/student-track-recycle-test-attachments";
    backupMocks.create.mockResolvedValue({ backupPath: "/tmp/test-recycle-backup.db", manifest: { createdAt: "2099-01-01T00:00:00.000Z" } });
    backupMocks.verify.mockResolvedValue({});
    const semester = await prisma.semester.create({ data: { name: `${marker}-PURGE`, startDate: "2099-01-01", endDate: "2099-12-31" } });
    const [removedClass, retainedClass] = await Promise.all([
      prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-PURGE-A`, deletedAt: new Date("2098-01-01") } }),
      prisma.class.create({ data: { semesterId: semester.id, code: `${marker}-PURGE-B` } }),
    ]);
    const [removedSession, retainedSession] = await Promise.all([
      prisma.classSession.create({ data: { semesterId: semester.id, classId: removedClass.id, code: "2099010196", date: "2099-01-01", semesterNumber: 1 } }),
      prisma.classSession.create({ data: { semesterId: semester.id, classId: retainedClass.id, code: "2099010195", date: "2099-01-01", semesterNumber: 1 } }),
    ]);
    const student = await prisma.student.create({ data: { name: "保留班事实学生", studentId: `${marker}-PURGE-STUDENT`, gender: "男" } });
    await prisma.studentClassEnrollment.create({
      data: { studentId: student.id, semesterId: semester.id, classId: removedClass.id },
    });
    const retainedEvent = await prisma.event.create({ data: { sessionId: retainedSession.id, studentId: student.id, type: "课堂表现", description: "其他班事实保留", rawText: "合成测试" } });
    const [removedCommunication, retainedCommunication] = await Promise.all([
      prisma.communication.create({ data: { sessionId: removedSession.id, studentId: student.id, target: "监护人", summary: "待永久清除的观察来源" } }),
      prisma.communication.create({ data: { sessionId: retainedSession.id, studentId: student.id, target: "监护人", summary: "跨班观察的保留来源" } }),
    ]);
    const orphanObservation = await prisma.teacherObservation.create({
      data: {
        studentId: student.id,
        kind: "repeated-parent-concern",
        topic: `${marker}-ORPHAN`,
        title: "仅来自回收班",
        evidenceSummary: "该摘要应随最后一条来源永久清除。",
        analysisVersion: "test-v1",
        sources: { create: { communicationId: removedCommunication.id, relatedSessionId: removedSession.id } },
      },
    });
    const retainedObservation = await prisma.teacherObservation.create({
      data: {
        studentId: student.id,
        kind: "repeated-parent-concern",
        topic: `${marker}-SHARED`,
        title: "同时来自两个班",
        evidenceSummary: "仍有活动来源时应保留。",
        analysisVersion: "test-v1",
        sources: {
          create: [
            { communicationId: removedCommunication.id, relatedSessionId: removedSession.id },
            { communicationId: retainedCommunication.id, relatedSessionId: retainedSession.id },
          ],
        },
      },
    });
    const studentSemesterMemory = await prisma.teachingMemory.create({
      data: {
        scopeType: "student",
        scopeId: student.id,
        semesterKey: `semester:${semester.id}`,
        semesterId: semester.id,
        memoryTier: "semester",
        status: "confirmed",
        content: JSON.stringify({ version: 1, items: [] }),
        sourceRefs: JSON.stringify([{ type: "session", id: removedSession.id }]),
        sourceFingerprint: `${marker}-PURGED-MEMORY`,
      },
    });
    await prisma.sessionMetricHistory.create({
      data: {
        metricId: `${marker}-PURGED-METRIC`, studentId: student.id, sessionId: removedSession.id,
        date: removedSession.date, scoreA: 3, scoreB: 3, scoreC: 3, scoreD: 5,
        operator: "teacher", changeType: "clear",
      },
    });
    const intake = await prisma.feedbackIntakeRun.create({
      data: {
        sessionCode: removedSession.code,
        sourceFingerprint: `${marker}-PURGED-INTAKE`,
        status: "ready",
      },
    });
    await prisma.draftRecord.createMany({ data: [
      { rawText: `${marker}-INTAKE`, parsedResult: "{}", sessionCode: removedSession.code, intakeRunId: intake.id },
      { rawText: `${marker}-feedback-intake:${intake.id}`, parsedResult: "{}", sessionCode: removedSession.code },
      { rawText: `${marker}-DIRECT-STANDARD`, parsedResult: "{}", sessionCode: removedSession.code, kind: "standard" },
      { rawText: `${marker}-DIRECT-WCC`, parsedResult: "{}", sessionCode: removedSession.code, kind: "correction" },
    ] });
    const retainedDraft = await prisma.draftRecord.create({ data: { rawText: `${marker}-RETAINED-DRAFT`, parsedResult: "{}", sessionCode: retainedSession.code, kind: "replacement" } });
    await prisma.teachingSummaryCache.createMany({ data: [
      { scopeType: "session", scopeKey: `session:${removedSession.code}`, includeCommunications: false, sourceFingerprint: marker, resultJson: "{}", promptVersion: "test", modelName: "test" },
      { scopeType: "date", scopeKey: `date:${semester.id}:${removedSession.date}`, includeCommunications: false, sourceFingerprint: marker, resultJson: "{}", promptVersion: "test", modelName: "test" },
    ] });
    const batch = await prisma.feedbackPlanBatch.create({ data: { requestKey: `${marker}-PURGE`, semesterId: semester.id, type: "event_micro", outputRequirement: "测试", status: "completed" } });
    await prisma.feedbackPlan.createMany({ data: [
      { type: "event_micro", outputRequirement: "测试", status: "needs_review", semesterId: semester.id, classId: removedClass.id, sessionId: removedSession.id, inputFingerprint: `${marker}-PURGE-A`, batchId: batch.id, batchOrder: 1 },
      { type: "event_micro", outputRequirement: "测试", status: "approved", semesterId: semester.id, classId: retainedClass.id, sessionId: retainedSession.id, inputFingerprint: `${marker}-PURGE-B`, batchId: batch.id, batchOrder: 2 },
    ] });

    await expect(purgeExpiredRecycleBin({ now: new Date("2099-01-01") })).resolves.toMatchObject({ purgedClasses: 1, backup: { verified: true } });
    await expect(prisma.class.findUnique({ where: { id: removedClass.id } })).resolves.toBeNull();
    await expect(prisma.feedbackPlanBatch.findUnique({ where: { id: batch.id } })).resolves.toBeNull();
    await expect(prisma.feedbackPlan.count({ where: { batchId: batch.id } })).resolves.toBe(0);
    await expect(prisma.class.findUnique({ where: { id: retainedClass.id } })).resolves.not.toBeNull();
    await expect(prisma.classSession.findUnique({ where: { id: retainedSession.id } })).resolves.not.toBeNull();
    await expect(prisma.event.findUnique({ where: { id: retainedEvent.id } })).resolves.not.toBeNull();
    await expect(prisma.sessionMetricHistory.count({ where: { sessionId: removedSession.id } })).resolves.toBe(0);
    await expect(prisma.draftRecord.count({ where: { sessionCode: removedSession.code } })).resolves.toBe(0);
    await expect(prisma.draftRecord.findUnique({ where: { id: retainedDraft.id } })).resolves.not.toBeNull();
    await expect(prisma.teachingSummaryCache.count({ where: { OR: [{ scopeKey: `session:${removedSession.code}` }, { scopeKey: `date:${semester.id}:${removedSession.date}` }] } })).resolves.toBe(0);
    await expect(prisma.teacherObservation.findUnique({ where: { id: orphanObservation.id } })).resolves.toBeNull();
    await expect(prisma.teacherObservation.findUnique({
      where: { id: retainedObservation.id },
      include: { sources: true },
    })).resolves.toMatchObject({ sources: [{ communicationId: retainedCommunication.id }] });
    await expect(prisma.teachingMemory.findUnique({ where: { id: studentSemesterMemory.id } })).resolves.toBeNull();
  });
});
