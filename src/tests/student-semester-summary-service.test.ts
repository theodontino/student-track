import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  calculateStudentSemesterSummary,
  getStudentSemesterSummaries,
} from "@/services/student-semester-summary-service";

const marker = "VITEST-SEMESTER-SUMMARY";
let currentSemesterId = "";
let previousSemesterId = "";
let oldClassId = "";
let newClassId = "";
let firstStudentId = "";
let secondStudentId = "";

beforeAll(async () => {
  const [oldClass, newClass] = await Promise.all([
    prisma.class.create({ data: { code: `${marker}-OLD`, name: `${marker} 原班` } }),
    prisma.class.create({ data: { code: `${marker}-NEW`, name: `${marker} 新班` } }),
  ]);
  oldClassId = oldClass.id;
  newClassId = newClass.id;

  const [previousSemester, currentSemester] = await Promise.all([
    prisma.semester.create({ data: { name: `${marker} 往期`, startDate: "2098-01-01", endDate: "2098-12-31" } }),
    prisma.semester.create({ data: { name: `${marker} 当前`, startDate: "2099-01-01", endDate: "2099-12-31" } }),
  ]);
  previousSemesterId = previousSemester.id;
  currentSemesterId = currentSemester.id;

  const [firstStudent, secondStudent] = await Promise.all([
    prisma.student.create({ data: { name: `${marker} 甲`, studentId: `${marker}-S1`, gender: "男", classId: oldClass.id } }),
    prisma.student.create({ data: { name: `${marker} 乙`, studentId: `${marker}-S2`, gender: "女", classId: newClass.id } }),
  ]);
  firstStudentId = firstStudent.id;
  secondStudentId = secondStudent.id;

  const previousSession = await prisma.classSession.create({
    data: { code: "2098120101", semesterId: previousSemester.id, semesterNumber: 1, date: "2098-12-01", classId: oldClass.id },
  });
  const currentSessions = await Promise.all([
    prisma.classSession.create({ data: { code: "2099011001", semesterId: currentSemester.id, semesterNumber: 1, date: "2099-01-10", classId: oldClass.id } }),
    prisma.classSession.create({ data: { code: "2099021001", semesterId: currentSemester.id, semesterNumber: 2, date: "2099-02-10", classId: oldClass.id } }),
    prisma.classSession.create({ data: { code: "2099121001", semesterId: currentSemester.id, semesterNumber: 3, date: "2099-12-10", classId: newClass.id } }),
  ]);

  await prisma.sessionMetric.createMany({
    data: [
      { studentId: firstStudent.id, sessionId: currentSessions[0].id, date: currentSessions[0].date, scoreA: 5, scoreB: 4, scoreC: 3, scoreD: 5, operator: "teacher" },
      { studentId: firstStudent.id, sessionId: currentSessions[1].id, date: currentSessions[1].date, scoreA: 3, scoreB: 2, scoreC: 1, scoreD: 3, operator: "teacher" },
      { studentId: firstStudent.id, sessionId: currentSessions[2].id, date: currentSessions[2].date, scoreA: 1, scoreB: 1, scoreC: 1, scoreD: 0, operator: "teacher" },
      { studentId: firstStudent.id, sessionId: previousSession.id, date: previousSession.date, scoreA: 1, scoreB: 1, scoreC: 1, scoreD: 5, operator: "teacher" },
      { studentId: secondStudent.id, sessionId: currentSessions[0].id, date: currentSessions[0].date, scoreA: 4, scoreB: 4, scoreC: 4, scoreD: 3, operator: "teacher" },
      { studentId: secondStudent.id, sessionId: null, date: currentSessions[0].date, scoreA: 0, scoreB: 0, scoreC: 0, scoreD: 0, operator: "teacher" },
    ],
  });
  await prisma.attendance.createMany({
    data: [
      { studentId: firstStudent.id, sessionId: currentSessions[0].id, present: true },
      { studentId: firstStudent.id, sessionId: currentSessions[1].id, present: false },
      { studentId: firstStudent.id, sessionId: currentSessions[2].id, present: true },
      { studentId: firstStudent.id, sessionId: previousSession.id, present: true },
    ],
  });

  // A class transfer must not hide records already attached to this student.
  await prisma.student.update({ where: { id: firstStudent.id }, data: { classId: newClass.id } });
});

afterAll(async () => {
  await prisma.student.deleteMany({ where: { studentId: { startsWith: marker } } });
  await prisma.semester.deleteMany({ where: { id: { in: [currentSemesterId, previousSemesterId] } } });
  await prisma.class.deleteMany({ where: { id: { in: [oldClassId, newClassId] } } });
});

describe("student semester summary", () => {
  it("calculates averages and the composite from source records", () => {
    const summary = calculateStudentSemesterSummary({
      semester: { id: "test-semester", name: "测试学期", startDate: "2099-01-01", endDate: "2099-12-31" },
      metrics: [{ scoreA: 5, scoreB: 4, scoreC: 2 }, { scoreA: 4, scoreB: 3, scoreC: 1 }],
      attendances: [{ present: true }, { present: false }],
    });
    expect(summary).toMatchObject({
      averageA: 4.5,
      averageB: 3.5,
      averageC: 1.5,
      attendanceScore: 3,
      total20: 12.5,
      score100: 63,
      ratedSessionCount: 2,
      attendanceRecordedCount: 2,
      presentCount: 1,
    });
  });

  it("keeps missing evaluation and attendance distinct from zero", () => {
    const summary = calculateStudentSemesterSummary({
      semester: { id: "test-semester", name: "测试学期", startDate: "2099-01-01", endDate: "2099-12-31" },
      metrics: [],
      attendances: [],
    });
    expect(summary.averageA).toBeNull();
    expect(summary.attendanceScore).toBeNull();
    expect(summary.total20).toBeNull();
    expect(summary.score100).toBeNull();
  });

  it("isolates semesters, excludes future and unbound metrics, and preserves transferred-student records", async () => {
    const result = await getStudentSemesterSummaries(
      [firstStudentId, secondStudentId],
      { semesterId: currentSemesterId, now: new Date("2099-06-01T12:00:00.000Z") },
    );
    expect(result.summaries.get(firstStudentId)).toMatchObject({
      averageA: 4,
      averageB: 3,
      averageC: 2,
      attendanceScore: 3,
      total20: 12,
      score100: 60,
      ratedSessionCount: 2,
      attendanceRecordedCount: 2,
      presentCount: 1,
    });
    expect(result.summaries.get(secondStudentId)).toMatchObject({
      averageA: 4,
      averageB: 4,
      averageC: 4,
      attendanceScore: null,
      total20: null,
      score100: null,
      ratedSessionCount: 1,
      attendanceRecordedCount: 0,
    });
  });

  it("rejects an unknown explicit semester", async () => {
    await expect(getStudentSemesterSummaries([firstStudentId], { semesterId: `${marker}-MISSING` }))
      .rejects.toMatchObject({ message: "学期不存在", status: 404 });
  });
});
