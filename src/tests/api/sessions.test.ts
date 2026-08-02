import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { TEST_FIXTURE } from "../../../scripts/test-fixture-data";

describe("/api/sessions", () => {
  it("GET returns 200 with array for valid params", async () => {
    const { GET } = await import("@/app/api/sessions/route");
    const url = `http://localhost:3000/api/sessions?semesterId=${TEST_FIXTURE.semester.id}&className=${encodeURIComponent(TEST_FIXTURE.class.name)}`;
    const req = new NextRequest(url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("code");
    expect(body[0]).toHaveProperty("date");
  });

  it("GET without className still returns 200", async () => {
    const { GET } = await import("@/app/api/sessions/route");
    const url = `http://localhost:3000/api/sessions?semesterId=${TEST_FIXTURE.semester.id}`;
    const req = new NextRequest(url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
