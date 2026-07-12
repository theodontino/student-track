import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAlertDashboard } from "@/services/alert-service";

const marker = "VITEST-DASHBOARD-SCOPE";
let currentSemesterId = "";
let oldSemesterId = "";
let currentClassId = "";
let oldClassId = "";
let currentStudentIds: string[] = [];

beforeAll(async () => {
  const oldClass = await prisma.class.create({ data: { code: `${marker}-OLD`, name: `${marker} 往期班` } });
  const currentClass = await prisma.class.create({ data: { code: `${marker}-NOW`, name: `${marker} 当前班` } });
  oldClassId = oldClass.id;
  currentClassId = currentClass.id;

  const oldSemester = await prisma.semester.create({
    data: { name: `${marker} 往期`, startDate: "2099-01-01", endDate: "2099-08-31" },
  });
  const currentSemester = await prisma.semester.create({
    data: { name: `${marker} 当前`, startDate: "2099-07-01", endDate: "2099-08-31" },
  });
  oldSemesterId = oldSemester.id;
  currentSemesterId = currentSemester.id;

  const oldStudent = await prisma.student.create({
    data: { name: `${marker} 往期学生`, studentId: `${marker}-S0`, gender: "男", classId: oldClass.id },
  });
  const currentStudents = await Promise.all([
    prisma.student.create({ data: { name: `${marker} 甲`, studentId: `${marker}-S1`, gender: "男", classId: oldClass.id } }),
    prisma.student.create({ data: { name: `${marker} 乙`, studentId: `${marker}-S2`, gender: "女", classId: currentClass.id } }),
    prisma.student.create({ data: { name: `${marker} 丙`, studentId: `${marker}-S3`, gender: "男", classId: currentClass.id } }),
  ]);
  currentStudentIds = currentStudents.map((student) => student.id);

  const oldSession = await prisma.classSession.create({
    data: { code: "2099070101", semesterId: oldSemester.id, semesterNumber: 1, date: "2099-07-01", classId: oldClass.id },
  });
  const currentSession = await prisma.classSession.create({
    data: { code: "2099071001", semesterId: currentSemester.id, semesterNumber: 1, date: "2099-07-10", classId: currentClass.id },
  });

  await prisma.attendance.create({ data: { sessionId: oldSession.id, studentId: oldStudent.id, present: true } });
  await prisma.sessionMetric.create({
    data: { sessionId: oldSession.id, studentId: oldStudent.id, date: oldSession.date, scoreA: 1, scoreB: 1, scoreC: 1, scoreD: 5, operator: "teacher" },
  });
  await prisma.attendance.createMany({
    data: currentStudents.map((student) => ({ sessionId: currentSession.id, studentId: student.id, present: true })),
  });
  const scores = [[1, 1, 1], [2, 2, 2], [5, 5, 5]];
  for (let index = 0; index < currentStudents.length; index++) {
    await prisma.sessionMetric.create({
      data: {
        sessionId: currentSession.id,
        studentId: currentStudents[index].id,
        date: currentSession.date,
        scoreA: scores[index][0],
        scoreB: scores[index][1],
        scoreC: scores[index][2],
        scoreD: 5,
        operator: "teacher",
      },
    });
  }
  await prisma.communication.create({
    data: {
      sessionId: currentSession.id,
      studentId: currentStudents[0].id,
      target: "母亲",
      summary: "用于验证最近活动排序",
      createdAt: new Date("2099-07-20T00:00:00.000Z"),
    },
  });
});

afterAll(async () => {
  await prisma.student.deleteMany({ where: { studentId: { startsWith: marker } } });
  await prisma.semester.deleteMany({ where: { id: { in: [currentSemesterId, oldSemesterId] } } });
  await prisma.class.deleteMany({ where: { id: { in: [currentClassId, oldClassId] } } });
});

describe("semester-isolated alert dashboard", () => {
  it("selects the newer overlapping semester and excludes previous students", async () => {
    const dashboard = await getAlertDashboard({ now: new Date("2099-07-15T12:00:00.000Z") });
    expect(dashboard.semester?.id).toBe(currentSemesterId);
    expect(dashboard.totalStudents).toBe(3);
    expect(dashboard.classOverview).toEqual([
      expect.objectContaining({ name: `${marker} 当前班`, studentCount: 3 }),
    ]);
    expect(dashboard.studentAlerts.every((alert) => !alert.studentName.includes("往期学生"))).toBe(true);
    expect(dashboard.studentAlerts[0]).toMatchObject({
      studentId: currentStudentIds[0],
      class: `${marker} 当前班`,
    });
  });

  it("uses an explicit past semester without current-student leakage", async () => {
    const dashboard = await getAlertDashboard({ semesterId: oldSemesterId });
    expect(dashboard.semester?.id).toBe(oldSemesterId);
    expect(dashboard.totalStudents).toBe(1);
    expect(dashboard.classOverview).toEqual([
      expect.objectContaining({ name: `${marker} 往期班`, studentCount: 1 }),
    ]);
  });

  it("falls back to the semester containing the latest session between terms", async () => {
    const dashboard = await getAlertDashboard({ now: new Date("2100-01-01T12:00:00.000Z") });
    expect(dashboard.semester?.id).toBe(currentSemesterId);
  });
});
