import { describe, it, expect } from "vitest";
import { GET, POST } from "@/app/api/students/route";
import { PATCH as PATCH_STATUS } from "@/app/api/students/[id]/status/route";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { TEST_FIXTURE } from "../../../scripts/test-fixture-data";

describe("/api/students", () => {
  it("GET returns 200 with array", async () => {
    const req = new NextRequest("http://localhost:3000/api/students");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET returns students with name/class/studentId", async () => {
    const req = new NextRequest("http://localhost:3000/api/students");
    const res = await GET(req);
    const body = await res.json();
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("name");
    expect(body[0]).toHaveProperty("class");
    expect(body[0]).toHaveProperty("studentId");
  });

  it("GET adds a semester summary only when requested", async () => {
    const legacy = await GET(new NextRequest("http://localhost:3000/api/students"));
    const legacyBody = await legacy.json();
    expect(legacyBody[0]).not.toHaveProperty("semesterSummary");

    const req = new NextRequest("http://localhost:3000/api/students?semesterSummary=true&semesterId=test-semester-1");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].semesterSummary).toMatchObject({
      semester: { id: "test-semester-1" },
      averageA: 3,
      averageB: 3,
      averageC: 3,
      attendanceScore: 5,
      total20: 14,
      score100: 70,
      ratedSessionCount: 1,
      attendanceRecordedCount: 2,
      presentCount: 2,
    });
  });

  it("GET returns 404 for an unknown requested semester", async () => {
    const req = new NextRequest("http://localhost:3000/api/students?semesterSummary=true&semesterId=missing-semester");
    const res = await GET(req);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "学期不存在" });
  });

  it("POST with missing fields returns 400", async () => {
    const req = new NextRequest("http://localhost:3000/api/students", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "测试生" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("changes roster status idempotently while default list remains backward compatible", async () => {
    const studentId = TEST_FIXTURE.students[1].id;
    const beforeLogs = await prisma.systemLog.count({
      where: { action: "student.roster-status.updated", targetId: studentId },
    });
    try {
      const first = await PATCH_STATUS(new NextRequest(`http://localhost:3000/api/students/${studentId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "inactive" }),
      }), { params: Promise.resolve({ id: studentId }) });
      expect(first.status).toBe(200);
      const firstBody = await first.json();
      expect(firstBody).toMatchObject({ rosterStatus: "INACTIVE", changed: true });

      const repeated = await PATCH_STATUS(new NextRequest(`http://localhost:3000/api/students/${studentId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "inactive" }),
      }), { params: Promise.resolve({ id: studentId }) });
      const repeatedBody = await repeated.json();
      expect(repeatedBody).toMatchObject({
        rosterStatus: "INACTIVE",
        statusEffectiveAt: firstBody.statusEffectiveAt,
        changed: false,
      });

      const all = await GET(new NextRequest("http://localhost:3000/api/students"));
      expect((await all.json()).some((student: { id: string }) => student.id === studentId)).toBe(true);
      const active = await GET(new NextRequest("http://localhost:3000/api/students?scope=active"));
      expect((await active.json()).some((student: { id: string }) => student.id === studentId)).toBe(false);
      expect(await prisma.systemLog.count({
        where: { action: "student.roster-status.updated", targetId: studentId },
      })).toBe(beforeLogs + 1);
    } finally {
      await prisma.student.update({
        where: { id: studentId },
        data: { rosterStatus: "ACTIVE", statusEffectiveAt: new Date() },
      });
    }
  });
});
