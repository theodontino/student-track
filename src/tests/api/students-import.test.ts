import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/students/import/route";
import { prisma } from "@/lib/prisma";
import { TEST_FIXTURE } from "../../../scripts/test-fixture-data";

const importedStudentId = "BETA-IMPORT-ACTIVE";

afterEach(async () => {
  await prisma.student.deleteMany({ where: { studentId: importedStudentId } });
  await prisma.studentClassEnrollment.update({
    where: { studentId_semesterId: { studentId: TEST_FIXTURE.students[0].id, semesterId: TEST_FIXTURE.semester.id } },
    data: { rosterStatus: "ACTIVE", statusEffectiveAt: new Date() },
  });
});

describe("/api/students/import", () => {
  it("creates new students as active and never reactivates an inactive match", async () => {
    await prisma.student.update({
      where: { id: TEST_FIXTURE.students[0].id },
      data: { enrollments: { update: { where: { studentId_semesterId: { studentId: TEST_FIXTURE.students[0].id, semesterId: TEST_FIXTURE.semester.id } }, data: { rosterStatus: "INACTIVE", statusEffectiveAt: new Date("2026-07-29T00:00:00Z") } } } },
    });
    const csv = [
      "姓名,班级,学号,性别",
      `${TEST_FIXTURE.students[0].name},${TEST_FIXTURE.class.code},${TEST_FIXTURE.students[0].studentId},男`,
      `新导入学生,${TEST_FIXTURE.class.code},${importedStudentId},女`,
    ].join("\n");
    const form = new FormData();
    form.append("file", new File([csv], "roster.csv", { type: "text/csv" }));
    form.append("semesterId", TEST_FIXTURE.semester.id);
    form.append("mode", "preview");

    const response = await POST(new NextRequest("http://localhost:3000/api/students/import", {
      method: "POST",
      body: form,
    }));
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview).toMatchObject({ success: true, rowCount: 2 });
    const commitForm = new FormData();
    commitForm.append("file", new File([csv], "roster.csv", { type: "text/csv" }));
    commitForm.append("semesterId", TEST_FIXTURE.semester.id);
    commitForm.append("mode", "confirm");
    commitForm.append("previewFingerprint", preview.fingerprint);
    const committed = await POST(new NextRequest("http://localhost:3000/api/students/import", { method: "POST", body: commitForm }));
    expect(committed.status).toBe(200);
    await expect(prisma.studentClassEnrollment.findUniqueOrThrow({
      where: { studentId_semesterId: { studentId: TEST_FIXTURE.students[0].id, semesterId: TEST_FIXTURE.semester.id } },
    })).resolves.toMatchObject({ rosterStatus: "ACTIVE" });
    await expect(prisma.studentClassEnrollment.findUniqueOrThrow({
      where: { studentId_semesterId: { studentId: (await prisma.student.findUniqueOrThrow({ where: { studentId: importedStudentId } })).id, semesterId: TEST_FIXTURE.semester.id } },
    })).resolves.toMatchObject({ rosterStatus: "ACTIVE" });
  });

  it("keeps preview protection, moves an imported student, and records the transfer", async () => {
    const targetClass = await prisma.class.create({
      data: { semesterId: TEST_FIXTURE.semester.id, code: "VITEST-IMPORT-TRANSFER", name: "导入转入班" },
    });
    const studentId = TEST_FIXTURE.students[0].id;
    const original = await prisma.studentClassEnrollment.findUniqueOrThrow({
      where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
    });
    const beforeLogs = await prisma.systemLog.count({ where: { action: "student.enrollment.transferred", targetId: studentId } });
    const csv = [
      "姓名,班级,学号,性别",
      `${TEST_FIXTURE.students[0].name},${targetClass.code},${TEST_FIXTURE.students[0].studentId},男`,
    ].join("\n");
    try {
      const previewForm = new FormData();
      previewForm.append("file", new File([csv], "roster-transfer.csv", { type: "text/csv" }));
      previewForm.append("semesterId", TEST_FIXTURE.semester.id);
      const previewResponse = await POST(new NextRequest("http://localhost:3000/api/students/import", { method: "POST", body: previewForm }));
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json();
      expect(preview.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "transfer", fromClassCode: TEST_FIXTURE.class.code, classCode: targetClass.code })]));

      const commitForm = new FormData();
      commitForm.append("file", new File([csv], "roster-transfer.csv", { type: "text/csv" }));
      commitForm.append("semesterId", TEST_FIXTURE.semester.id);
      commitForm.append("mode", "confirm");
      commitForm.append("previewFingerprint", preview.fingerprint);
      commitForm.append("previewSemesterId", preview.semesterId);
      const committed = await POST(new NextRequest("http://localhost:3000/api/students/import", { method: "POST", body: commitForm }));
      expect(committed.status).toBe(200);
      await expect(prisma.studentClassEnrollment.findUniqueOrThrow({
        where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
      })).resolves.toMatchObject({ classId: targetClass.id, rosterStatus: "ACTIVE" });
      await expect(committed.json()).resolves.toMatchObject({ enrollmentsUpdated: 1 });
      expect(await prisma.systemLog.count({ where: { action: "student.enrollment.transferred", targetId: studentId } })).toBe(beforeLogs + 1);
    } finally {
      await prisma.studentClassEnrollment.update({
        where: { studentId_semesterId: { studentId, semesterId: TEST_FIXTURE.semester.id } },
        data: { classId: original.classId, rosterStatus: "ACTIVE", statusEffectiveAt: new Date() },
      });
      await prisma.class.delete({ where: { id: targetClass.id } });
    }
  });
});
