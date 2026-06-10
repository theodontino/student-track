import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

let semesterId: string;
let className: string;

beforeAll(async () => {
  const sem = await prisma.semester.findFirst({ select: { id: true } });
  semesterId = sem!.id;
  const cls = await prisma.class.findFirst({ select: { name: true, code: true } });
  className = cls!.name ?? cls!.code;
});

describe("/api/sessions", () => {
  it("GET returns 200 with array for valid params", async () => {
    const { GET } = await import("@/app/api/sessions/route");
    const url = `http://localhost:3000/api/sessions?semesterId=${semesterId}&className=${encodeURIComponent(className)}`;
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
    const url = `http://localhost:3000/api/sessions?semesterId=${semesterId}`;
    const req = new NextRequest(url);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
