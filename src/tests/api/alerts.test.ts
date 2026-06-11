import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/alerts/route";

describe("/api/alerts", () => {
  it("GET returns 200 with alert structure", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("classOverview");
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
  });
});
