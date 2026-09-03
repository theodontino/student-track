import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

let sessionId: string;
let studentId: string;

beforeAll(async () => {
  const ses = await prisma.classSession.findFirst({ select: { id: true } });
  sessionId = ses!.id;
  const attendance = await prisma.attendance.findFirst({ select: { studentId: true } });
  studentId = attendance!.studentId;
});

describe("/api/attendance", () => {
  it("GET with sessionId returns 200 with array", async () => {
    const { GET } = await import("@/app/api/attendance/route");
    const url = `http://localhost:3000/api/attendance?sessionId=${sessionId}`;
    const req = new NextRequest(url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET with studentId returns attendance history with session info", async () => {
    const { GET } = await import("@/app/api/attendance/route");
    const url = `http://localhost:3000/api/attendance?studentId=${studentId}`;
    const req = new NextRequest(url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("studentId", studentId);
    expect(body[0]).toHaveProperty("session");
    expect(body[0].session).toHaveProperty("date");
    expect(body[0].session).toHaveProperty("semesterNumber");
  });

  it("GET without query id returns 400", async () => {
    const { GET } = await import("@/app/api/attendance/route");
    const req = new NextRequest("http://localhost:3000/api/attendance");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("GET returns 409 for a session whose class is in the recycle bin", async () => {
    const semester = await prisma.semester.create({ data: { name: "TEST-ATTENDANCE-RECYCLE", startDate: "2099-01-01", endDate: "2099-12-31" } });
    const klass = await prisma.class.create({ data: { semesterId: semester.id, code: "TEST-ATTENDANCE-RECYCLE", deletedAt: new Date() } });
    const session = await prisma.classSession.create({ data: { semesterId: semester.id, classId: klass.id, code: "TEST-ATTENDANCE-RECYCLE", date: "2099-01-01", semesterNumber: 1 } });
    try {
      const { GET } = await import("@/app/api/attendance/route");
      const res = await GET(new NextRequest(`http://localhost:3000/api/attendance?sessionId=${session.id}`));
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ code: "scope_in_recycle_bin" });
    } finally {
      await prisma.classSession.delete({ where: { id: session.id } });
      await prisma.class.delete({ where: { id: klass.id } });
      await prisma.semester.delete({ where: { id: semester.id } });
    }
  });
});
