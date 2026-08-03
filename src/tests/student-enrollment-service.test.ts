import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  assertClassInSemester,
  getStudentEnrollment,
  listSemesterClasses,
  projectStudentEnrollment,
  upsertStudentEnrollment,
} from "@/services/student-enrollment-service";

const marker = "VITEST-ENROLLMENT-SCOPE";
let firstSemesterId = "";
let secondSemesterId = "";
let firstClassId = "";
let secondClassId = "";
let studentId = "";

beforeAll(async () => {
  const first = await prisma.semester.create({ data: { name: `${marker} 一`, startDate: "2099-01-01", endDate: "2099-06-30" } });
  const second = await prisma.semester.create({ data: { name: `${marker} 二`, startDate: "2099-07-01", endDate: "2099-12-31" } });
  firstSemesterId = first.id;
  secondSemesterId = second.id;
  const firstClass = await prisma.class.create({ data: { semesterId: first.id, code: `${marker}-01`, name: "第一学期班" } });
  const secondClass = await prisma.class.create({ data: { semesterId: second.id, code: `${marker}-01`, name: "第二学期班" } });
  firstClassId = firstClass.id;
  secondClassId = secondClass.id;
  const student = await prisma.student.create({ data: { name: `${marker} 学生`, studentId: `${marker}-S1`, gender: "女" } });
  studentId = student.id;
  await upsertStudentEnrollment(prisma, { studentId, semesterId: first.id, classId: firstClass.id });
  await upsertStudentEnrollment(prisma, { studentId, semesterId: second.id, classId: secondClass.id });
});

afterAll(async () => {
  await prisma.student.deleteMany({ where: { id: studentId } });
  await prisma.class.deleteMany({ where: { id: { in: [firstClassId, secondClassId] } } });
  await prisma.semester.deleteMany({ where: { id: { in: [firstSemesterId, secondSemesterId] } } });
});

describe("StudentClassEnrollment service", () => {
  it("allows the same class code in different semesters", async () => {
    const classes = await listSemesterClasses(prisma, firstSemesterId);
    const otherClasses = await listSemesterClasses(prisma, secondSemesterId);
    expect(classes[0]).toMatchObject({
      code: `${marker}-01`,
      semesterId: firstSemesterId,
      activeStudentCount: 1,
      inactiveStudentCount: 0,
    });
    expect(otherClasses[0]).toMatchObject({ code: `${marker}-01`, semesterId: secondSemesterId });
  });

  it("keeps one enrollment per student and semester while allowing transfer", async () => {
    await expect(upsertStudentEnrollment(prisma, { studentId, semesterId: firstSemesterId, classId: secondClassId })).rejects.toMatchObject({ status: 409 });
    const moved = await upsertStudentEnrollment(prisma, { studentId, semesterId: firstSemesterId, classId: firstClassId, rosterStatus: "INACTIVE" });
    expect(moved.classId).toBe(firstClassId);
    expect(moved.rosterStatus).toBe("INACTIVE");
    await expect(listSemesterClasses(prisma, firstSemesterId)).resolves.toEqual([
      expect.objectContaining({ activeStudentCount: 0, inactiveStudentCount: 1 }),
    ]);
    const second = await getStudentEnrollment(prisma, studentId, secondSemesterId);
    expect(second?.classId).toBe(secondClassId);
    expect(projectStudentEnrollment([second!]).classId).toBe(secondClassId);
  });

  it("rejects a class from another semester", async () => {
    await expect(assertClassInSemester(prisma, firstClassId, secondSemesterId)).rejects.toMatchObject({ status: 409 });
  });
});
