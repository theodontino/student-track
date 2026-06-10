import { describe, it, expect } from "vitest";
import { GET, POST } from "@/app/api/semesters/route";
import { NextRequest } from "next/server";

describe("/api/semesters", () => {
  it("GET returns 200 with array", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it("GET returns semesters with id/name/startDate/endDate", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body[0]).toHaveProperty("id");
    expect(body[0]).toHaveProperty("name");
    expect(body[0]).toHaveProperty("startDate");
    expect(body[0]).toHaveProperty("endDate");
  });

  it("POST with missing body returns 400", async () => {
    const req = new NextRequest("http://localhost:3000/api/semesters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
