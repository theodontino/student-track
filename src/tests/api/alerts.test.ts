import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/alerts/route";

describe("/api/alerts", () => {
  it("GET returns 200 with alert structure", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("classOverview");
    expect(body).toHaveProperty("semester");
    expect(body).toHaveProperty("classAlerts");
    expect(body).toHaveProperty("studentAlerts");
    expect(body).toHaveProperty("totalStudents");
    expect(body).toHaveProperty("redCount");
    expect(body).toHaveProperty("yellowCount");
  });

  it("classOverview has expected shape", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.classOverview.length).toBeGreaterThan(0);
    const first = body.classOverview[0];
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("avgA");
    expect(first).toHaveProperty("avgB");
    expect(first).toHaveProperty("avgC");
    expect(first).toHaveProperty("avgD");
    expect(first).toHaveProperty("studentCount");
    expect(first).toHaveProperty("lastActivityAt");
  });

  it("returns 404 for an unknown explicit semester", async () => {
    const request = new NextRequest("http://localhost:3000/api/alerts?semesterId=NO-SUCH-SEMESTER");
    const response = await GET(request);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "学期不存在" });
  });
});
