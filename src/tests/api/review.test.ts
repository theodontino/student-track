import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/review/route";
import { NextRequest } from "next/server";

describe("/api/review", () => {
  it("GET returns 200 with draft array", async () => {
    const url = "http://localhost:3000/api/review?status=pending";
    const req = new NextRequest(url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET with status=confirmed returns array", async () => {
    const url = "http://localhost:3000/api/review?status=confirmed";
    const req = new NextRequest(url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("POST without draftId returns 400", async () => {
    const { POST } = await import("@/app/api/review/route");
    const req = new NextRequest("http://localhost:3000/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
