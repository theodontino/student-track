import { describe, it, expect } from "vitest";
import { GET, POST } from "@/app/api/students/route";
import { NextRequest } from "next/server";

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
});
