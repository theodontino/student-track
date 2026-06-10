import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/system/logs/route";
import { NextRequest } from "next/server";

describe("/api/system/logs", () => {
  it("GET returns 200 with array", async () => {
    const req = new NextRequest("http://localhost:3000/api/system/logs");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.logs)).toBe(true);
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("hasMore");
  });
});
