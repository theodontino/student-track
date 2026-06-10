import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

let semesterId: string;
let className: string;
let sessionCode: string;

beforeAll(async () => {
  const sem = await prisma.semester.findFirst({ select: { id: true } });
  semesterId = sem!.id;
  const cls = await prisma.class.findFirst({ select: { name: true, code: true } });
  className = cls!.name ?? cls!.code;
  const ses = await prisma.classSession.findFirst({
    where: { semesterId },
    select: { code: true },
  });
  sessionCode = ses!.code;
});

describe("/api/quick-score", () => {
  it("GET with class + sessionCode returns 200", async () => {
    const { GET } = await import("@/app/api/quick-score/route");
    const params = new URLSearchParams({ class: className, sessionCode });
    const url = `http://localhost:3000/api/quick-score?${params}`;
    const req = new NextRequest(url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("scores");
    expect(body).toHaveProperty("className", className);
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
});
