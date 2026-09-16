import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/students/import/route";
import { prisma } from "@/lib/prisma";
import { TEST_FIXTURE } from "../../../scripts/test-fixture-data";
import * as XLSX from "xlsx";

const importedStudentId = "BETA-IMPORT-ACTIVE";
const wideImportedStudentId = "TEST-WIDE-IMPORT-001";
const wideClassCode = "TEST-WIDE-CLASS";

afterEach(async () => {
  await prisma.student.deleteMany({ where: { studentId: importedStudentId } });
  await prisma.student.deleteMany({ where: { studentId: wideImportedStudentId } });
  await prisma.class.deleteMany({ where: { semesterId: TEST_FIXTURE.semester.id, code: wideClassCode } });
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
    commitForm.append("previewSelectionKey", preview.selectionKey);
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
      commitForm.append("previewSelectionKey", preview.selectionKey);
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

  it("analyzes a wide roster, imports only selected classes, and stores missing gender as unknown", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["教师", "班级编码", "班级名称", "班级对应科目", "学员编号", "学员姓名", "其他字段"],
      ["测试教师", wideClassCode, "合成宽表班", "英语", wideImportedStudentId, "张三", "忽略"],
      ["其他教师", "TEST-UNSELECTED", "不导入班", "数学", "TEST-UNSELECTED-001", "李四", "忽略"],
    ]), "机构花名册");
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = () => new File([bytes], "synthetic-wide-roster.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const analyzeForm = new FormData();
    analyzeForm.append("file", file());
    analyzeForm.append("semesterId", TEST_FIXTURE.semester.id);
    analyzeForm.append("mode", "analyze");
    const analyzed = await POST(new NextRequest("http://localhost:3000/api/students/import", { method: "POST", body: analyzeForm }));
    expect(analyzed.status).toBe(200);
    await expect(analyzed.json()).resolves.toMatchObject({ mode: "analyze", rowCount: 2, classes: expect.arrayContaining([expect.objectContaining({ classCode: wideClassCode, subject: "英语", teacher: "测试教师" })]) });

    const previewForm = new FormData();
    previewForm.append("file", file());
    previewForm.append("semesterId", TEST_FIXTURE.semester.id);
    previewForm.append("mode", "preview");
    previewForm.append("selectedClassCodes", JSON.stringify([wideClassCode]));
    const previewResponse = await POST(new NextRequest("http://localhost:3000/api/students/import", { method: "POST", body: previewForm }));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({ rowCount: 1, changes: expect.arrayContaining([expect.objectContaining({ kind: "student_created", gender: "未知" })]) });

    const mismatchedForm = new FormData();
    mismatchedForm.append("file", file());
    mismatchedForm.append("semesterId", TEST_FIXTURE.semester.id);
    mismatchedForm.append("mode", "confirm");
    mismatchedForm.append("selectedClassCodes", JSON.stringify(["TEST-UNSELECTED"]));
    mismatchedForm.append("previewFingerprint", preview.fingerprint);
    mismatchedForm.append("previewSelectionKey", preview.selectionKey);
    mismatchedForm.append("previewSemesterId", preview.semesterId);
    const mismatched = await POST(new NextRequest("http://localhost:3000/api/students/import", { method: "POST", body: mismatchedForm }));
    expect(mismatched.status).toBe(409);
    await expect(mismatched.json()).resolves.toMatchObject({ code: "selection_mismatch" });
    await expect(prisma.student.findUnique({ where: { studentId: "TEST-UNSELECTED-001" } })).resolves.toBeNull();

    const confirmForm = new FormData();
    confirmForm.append("file", file());
    confirmForm.append("semesterId", TEST_FIXTURE.semester.id);
    confirmForm.append("mode", "confirm");
    confirmForm.append("selectedClassCodes", JSON.stringify([wideClassCode]));
    confirmForm.append("previewFingerprint", preview.fingerprint);
    confirmForm.append("previewSelectionKey", preview.selectionKey);
    confirmForm.append("previewSemesterId", preview.semesterId);
    const committed = await POST(new NextRequest("http://localhost:3000/api/students/import", { method: "POST", body: confirmForm }));
    expect(committed.status).toBe(200);
    await expect(prisma.student.findUniqueOrThrow({ where: { studentId: wideImportedStudentId } })).resolves.toMatchObject({ name: "张三", gender: "未知" });
    await expect(prisma.class.findUniqueOrThrow({ where: { semesterId_code: { semesterId: TEST_FIXTURE.semester.id, code: wideClassCode } } })).resolves.toMatchObject({ name: "合成宽表班" });
    await expect(prisma.student.findUnique({ where: { studentId: "TEST-UNSELECTED-001" } })).resolves.toBeNull();
  });
});
