import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/students/[id]/enrollment/route";
import { PUT } from "@/app/api/students/[id]/route";
import { prisma } from "@/lib/prisma";
import { TEST_FIXTURE } from "../../../scripts/test-fixture-data";

function patchRequest(studentId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3000/api/students/${studentId}/enrollment`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("student enrollment transfer API", () => {
  it("moves only the current affiliation, preserves history/status, and is idempotent", async () => {
    const studentId = TEST_FIXTURE.students[0].id;
    const original = await prisma.studentClassEnrollment.findUniqueOrThrow({
      where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
    });
    const statusEffectiveAt = new Date("2026-07-29T12:00:00.000Z");
    await prisma.studentClassEnrollment.update({
      where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
      data: { rosterStatus: "INACTIVE", statusEffectiveAt },
    });
    const target = await prisma.class.create({
      data: { semesterId: TEST_FIXTURE.semester.id, code: "VITEST-TRANSFER-TARGET", name: "转班目标班" },
    });
    const otherSemester = await prisma.semester.create({
      data: { name: "VITEST 转班其他学期", startDate: "2098-01-01", endDate: "2098-06-30" },
    });
    const otherClass = await prisma.class.create({
      data: { semesterId: otherSemester.id, code: "VITEST-OTHER-CLASS", name: "其他学期班" },
    });
    const metricIds = (await prisma.sessionMetric.findMany({ where: { studentId }, select: { id: true } })).map((row) => row.id);
    const communicationIds = (await prisma.communication.findMany({ where: { studentId }, select: { id: true } })).map((row) => row.id);
    const feedbackPlanIds = (await prisma.feedbackPlan.findMany({ where: { classId: original.classId }, select: { id: true, classId: true } })).map((row) => row.id);
    const beforeLogs = await prisma.systemLog.count({ where: { action: "student.enrollment.transferred", targetId: studentId } });

    try {
      const response = await PATCH(
        patchRequest(studentId, { semesterId: TEST_FIXTURE.semester.id, classId: target.id }),
        { params: Promise.resolve({ id: studentId }) },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: studentId,
        semesterId: TEST_FIXTURE.semester.id,
        changed: true,
        previousClass: { id: original.classId },
        currentClass: { id: target.id, semesterId: TEST_FIXTURE.semester.id },
        class: { id: target.id, semesterId: TEST_FIXTURE.semester.id },
        rosterStatus: "INACTIVE",
        statusEffectiveAt: statusEffectiveAt.toISOString(),
      });
      await expect(prisma.studentClassEnrollment.findUniqueOrThrow({
        where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
      })).resolves.toMatchObject({ classId: target.id, rosterStatus: "INACTIVE", statusEffectiveAt });
      await expect(prisma.sessionMetric.findMany({ where: { studentId }, select: { id: true } })).resolves.toEqual(expect.arrayContaining(metricIds.map((id) => ({ id }))));
      await expect(prisma.communication.findMany({ where: { studentId }, select: { id: true } })).resolves.toEqual(expect.arrayContaining(communicationIds.map((id) => ({ id }))));
      await expect(prisma.feedbackPlan.findMany({ where: { id: { in: feedbackPlanIds } }, select: { id: true, classId: true } })).resolves.toEqual(expect.arrayContaining(feedbackPlanIds.map((id) => ({ id, classId: original.classId }))));
      expect(await prisma.systemLog.count({ where: { action: "student.enrollment.transferred", targetId: studentId } })).toBe(beforeLogs + 1);
      const transferLog = await prisma.systemLog.findFirst({
        where: { action: "student.enrollment.transferred", targetId: studentId },
        orderBy: { createdAt: "desc" },
      });
      expect(JSON.parse(transferLog?.detail ?? "{}")).toMatchObject({
        semesterId: TEST_FIXTURE.semester.id,
        fromClass: { id: original.classId },
        toClass: { id: target.id },
      });

      const repeated = await PATCH(
        patchRequest(studentId, { semesterId: TEST_FIXTURE.semester.id, classId: target.id }),
        { params: Promise.resolve({ id: studentId }) },
      );
      expect(repeated.status).toBe(200);
      await expect(repeated.json()).resolves.toMatchObject({ changed: false, previousClass: { id: target.id }, class: { id: target.id } });
      expect(await prisma.systemLog.count({ where: { action: "student.enrollment.transferred", targetId: studentId } })).toBe(beforeLogs + 1);

      const wrongSemester = await PATCH(
        patchRequest(studentId, { semesterId: TEST_FIXTURE.semester.id, classId: otherClass.id }),
        { params: Promise.resolve({ id: studentId }) },
      );
      expect(wrongSemester.status).toBe(409);

      const invalidClass = await PATCH(
        patchRequest(studentId, { semesterId: TEST_FIXTURE.semester.id, classId: "missing-transfer-class" }),
        { params: Promise.resolve({ id: studentId }) },
      );
      expect(invalidClass.status).toBe(404);

      const withoutEnrollment = await prisma.student.create({ data: { name: "转班无归属学生", studentId: "VITEST-NO-ENROLLMENT", gender: "女" } });
      try {
        const missingEnrollment = await PATCH(
          patchRequest(withoutEnrollment.id, { semesterId: TEST_FIXTURE.semester.id, classId: target.id }),
          { params: Promise.resolve({ id: withoutEnrollment.id }) },
        );
        expect(missingEnrollment.status).toBe(409);
      } finally {
        await prisma.student.delete({ where: { id: withoutEnrollment.id } });
      }

      const unknownStudent = await PATCH(
        patchRequest("missing-transfer-student", { semesterId: TEST_FIXTURE.semester.id, classId: target.id }),
        { params: Promise.resolve({ id: "missing-transfer-student" }) },
      );
      expect(unknownStudent.status).toBe(404);
    } finally {
      await prisma.studentClassEnrollment.update({
        where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
        data: { classId: original.classId, rosterStatus: original.rosterStatus, statusEffectiveAt: original.statusEffectiveAt },
      });
      await prisma.class.delete({ where: { id: target.id } });
      await prisma.class.delete({ where: { id: otherClass.id } });
      await prisma.semester.delete({ where: { id: otherSemester.id } });
    }
  });

  it("keeps the existing PUT class compatibility on the shared guarded path", async () => {
    const studentId = TEST_FIXTURE.students[1].id;
    const original = await prisma.studentClassEnrollment.findUniqueOrThrow({
      where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
    });
    const target = await prisma.class.create({
      data: { semesterId: TEST_FIXTURE.semester.id, code: "VITEST-PUT-TRANSFER", name: "PUT目标班" },
    });
    try {
      const response = await PUT(new NextRequest(`http://localhost:3000/api/students/${studentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ semesterId: TEST_FIXTURE.semester.id, classId: target.id }),
      }), { params: Promise.resolve({ id: studentId }) });
      expect(response.status).toBe(200);
      await expect(prisma.studentClassEnrollment.findUniqueOrThrow({
        where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
      })).resolves.toMatchObject({ classId: target.id, rosterStatus: original.rosterStatus, statusEffectiveAt: original.statusEffectiveAt });
    } finally {
      await prisma.studentClassEnrollment.update({
        where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
        data: { classId: original.classId, rosterStatus: original.rosterStatus, statusEffectiveAt: original.statusEffectiveAt },
      });
      await prisma.class.delete({ where: { id: target.id } });
    }
  });
});
