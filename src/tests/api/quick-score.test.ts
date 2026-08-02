import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { TEST_FIXTURE } from "../../../scripts/test-fixture-data";

describe("/api/quick-score", () => {
  it("GET with class + sessionCode returns 200", async () => {
    const { GET } = await import("@/app/api/quick-score/route");
    const params = new URLSearchParams({
      class: TEST_FIXTURE.class.name,
      sessionCode: TEST_FIXTURE.sessions[0].code,
    });
    const url = `http://localhost:3000/api/quick-score?${params}`;
    const req = new NextRequest(url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("scores");
    expect(body).toHaveProperty("className", TEST_FIXTURE.class.name);
  });

  it("GET without class returns 400", async () => {
    const { GET } = await import("@/app/api/quick-score/route");
    const req = new NextRequest("http://localhost:3000/api/quick-score");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("POST without scores returns 400", async () => {
    const { POST } = await import("@/app/api/quick-score/route");
    const req = new NextRequest("http://localhost:3000/api/quick-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("POST with nonexistent sessionCode returns 404", async () => {
    const { POST } = await import("@/app/api/quick-score/route");
    const req = new NextRequest("http://localhost:3000/api/quick-score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode: "NO_SUCH_SESSION",
        scores: [{ studentId: TEST_FIXTURE.students[0].id, scoreA: 4, scoreB: 4, scoreC: 4 }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });
});
