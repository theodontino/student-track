import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

let testStudent: { id: string; name: string; studentId: string };

beforeAll(async () => {
  const student = await prisma.student.findFirst({
    select: { id: true, name: true, studentId: true },
    orderBy: { studentId: "asc" },
  });
  expect(student).toBeTruthy();
  testStudent = student!;
});

describe("/api/students/[id]", () => {
  it("GET returns 200 with student detail", async () => {
    const { GET } = await import("@/app/api/students/[id]/route");
    const req = new NextRequest(`http://localhost:3000/api/students/${testStudent.id}`);
    const res = await GET(req, { params: Promise.resolve({ id: testStudent.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("name", testStudent.name);
    expect(body).toHaveProperty("studentId", testStudent.studentId);
    expect(body).toHaveProperty("sessionMetrics");
    expect(body).toHaveProperty("events");
    expect(body).not.toHaveProperty("semesterSummary");
  });

  it("GET returns semester-isolated teaching data and the derived summary", async () => {
    const { GET } = await import("@/app/api/students/[id]/route");
    const req = new NextRequest(`http://localhost:3000/api/students/${testStudent.id}?semesterSummary=true&semesterId=test-semester-1`);
    const res = await GET(req, { params: Promise.resolve({ id: testStudent.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.semesterSummary).toMatchObject({
      semester: { id: "test-semester-1" },
      averageA: 3,
      attendanceScore: 5,
      score100: 70,
    });
    expect(body.sessionMetrics).toHaveLength(1);
    expect(body.attendances).toHaveLength(2);
    expect(body.events.every((event: { session: { code: string } }) => event.session.code.startsWith("2026"))).toBe(true);
    expect(body.communications.every((communication: { session: { code: string } }) => communication.session.code.startsWith("2026"))).toBe(true);
  });

  it("GET returns 404 for an unknown semester in semester mode", async () => {
    const { GET } = await import("@/app/api/students/[id]/route");
    const req = new NextRequest(`http://localhost:3000/api/students/${testStudent.id}?semesterSummary=true&semesterId=missing-semester`);
    const res = await GET(req, { params: Promise.resolve({ id: testStudent.id }) });
    expect(res.status).toBe(404);
  });

  it("does not expose enrollment or facts from a recycled class", async () => {
    const { GET } = await import("@/app/api/students/[id]/route");
    const klass = await prisma.class.create({
      data: { id: "test-student-detail-recycled-class", semesterId: "test-semester-1", code: "RECYCLED-DETAIL", name: "回收班" },
    });
    const student = await prisma.student.create({
      data: {
        id: "test-student-detail-recycled-student",
        name: "回收班合成学生",
        studentId: "TEST-RECYCLED-DETAIL-STUDENT",
        gender: "女",
        enrollments: { create: { semesterId: "test-semester-1", classId: klass.id } },
      },
    });
    const session = await prisma.classSession.create({
      data: { id: "test-student-detail-recycled-session", code: "2026063099", semesterId: "test-semester-1", semesterNumber: 99, date: "2026-06-30", classId: klass.id },
    });
    await prisma.attendance.create({ data: { sessionId: session.id, studentId: student.id, present: true } });
    await prisma.sessionMetric.create({ data: { sessionId: session.id, studentId: student.id, date: session.date, scoreA: 5, scoreB: 5, scoreC: 5, scoreD: 5, operator: "teacher" } });
    await prisma.event.create({ data: { sessionId: session.id, studentId: student.id, type: "课堂表现", description: "不应显示", rawText: "合成" } });
    await prisma.communication.create({ data: { sessionId: session.id, studentId: student.id, target: "母亲", summary: "不应显示" } });
    await prisma.class.update({ where: { id: klass.id }, data: { deletedAt: new Date() } });

    try {
      const response = await GET(
        new NextRequest(`http://localhost:3000/api/students/${student.id}?semesterSummary=true&semesterId=test-semester-1`),
        { params: Promise.resolve({ id: student.id }) },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ classId: null, classCode: null, sessionMetrics: [], events: [], communications: [], attendances: [] });
    } finally {
      await prisma.class.update({ where: { id: klass.id }, data: { deletedAt: null } });
      await prisma.student.delete({ where: { id: student.id } });
      await prisma.classSession.delete({ where: { id: session.id } });
      await prisma.class.delete({ where: { id: klass.id } });
    }
  });

  it("does not expose score history snapshots from a recycled class", async () => {
    const { GET } = await import("@/app/api/students/[id]/history/route");
    const [activeClass, recycledClass] = await Promise.all([
      prisma.class.create({
        data: { semesterId: "test-semester-1", code: "TEST-HISTORY-ACTIVE", name: "历史可用班" },
      }),
      prisma.class.create({
        data: { semesterId: "test-semester-1", code: "TEST-HISTORY-RECYCLED", name: "历史回收班" },
      }),
    ]);
    const [activeSession, recycledSession] = await Promise.all([
      prisma.classSession.create({
        data: { semesterId: "test-semester-1", classId: activeClass.id, code: "2026063097", semesterNumber: 97, date: "2026-06-29" },
      }),
      prisma.classSession.create({
        data: { semesterId: "test-semester-1", classId: recycledClass.id, code: "2026063098", semesterNumber: 98, date: "2026-06-30" },
      }),
    ]);
    const [visibleHistory, recycledHistory] = await Promise.all([
      prisma.sessionMetricHistory.create({
        data: { metricId: "test-history-active-metric", studentId: testStudent.id, sessionId: activeSession.id, date: activeSession.date, scoreA: 4, scoreB: 4, scoreC: 4, scoreD: 5, operator: "teacher", changeType: "update" },
      }),
      prisma.sessionMetricHistory.create({
        data: { metricId: "test-history-recycled-metric", studentId: testStudent.id, sessionId: recycledSession.id, date: recycledSession.date, scoreA: 1, scoreB: 1, scoreC: 1, scoreD: 1, operator: "teacher", changeType: "clear" },
      }),
    ]);
    await prisma.class.update({ where: { id: recycledClass.id }, data: { deletedAt: new Date() } });

    try {
      const response = await GET(
        new NextRequest(`http://localhost:3000/api/students/${testStudent.id}/history`),
        { params: Promise.resolve({ id: testStudent.id }) },
      );
      expect(response.status).toBe(200);
      const body = await response.json() as Array<{ id: string }>;
      expect(body.map((item) => item.id)).toContain(visibleHistory.id);
      expect(body.map((item) => item.id)).not.toContain(recycledHistory.id);
    } finally {
      await prisma.sessionMetricHistory.deleteMany({ where: { id: { in: [visibleHistory.id, recycledHistory.id] } } });
      await prisma.class.update({ where: { id: recycledClass.id }, data: { deletedAt: null } });
      await prisma.classSession.deleteMany({ where: { id: { in: [activeSession.id, recycledSession.id] } } });
      await prisma.class.deleteMany({ where: { id: { in: [activeClass.id, recycledClass.id] } } });
    }
  });

  it("GET nonexistent id returns 404", async () => {
    const { GET } = await import("@/app/api/students/[id]/route");
    const req = new NextRequest("http://localhost:3000/api/students/nonexistent");
    const res = await GET(req, { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  it("PUT returns 200 and updates labels", async () => {
    const { PUT } = await import("@/app/api/students/[id]/route");
    const req = new NextRequest(`http://localhost:3000/api/students/${testStudent.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labels: ["#逻辑强", "#基础扎实", "#学霸"] }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: testStudent.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("name", testStudent.name);
  });
});
