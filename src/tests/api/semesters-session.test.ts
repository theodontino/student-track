import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

let semesterId: string;
let sessionCode: string;

beforeAll(async () => {
  const sem = await prisma.semester.findFirst({ select: { id: true } });
  semesterId = sem!.id;
  const ses = await prisma.classSession.findFirst({
    where: { semesterId: sem!.id },
    select: { code: true },
  });
  sessionCode = ses!.code;
});

describe("/api/semesters/[id]/session", () => {
  it("DELETE nonexistent code returns 404", async () => {
    const { DELETE } = await import("@/app/api/semesters/[id]/session/route");
    const url = `http://localhost:3000/api/semesters/${semesterId}/session?code=NONEXIST`;
    const req = new NextRequest(url);
    const res = await DELETE(req, { params: Promise.resolve({ id: semesterId }) });
    expect(res.status).toBe(404);
  });

  it("DELETE without code returns 400", async () => {
    const { DELETE } = await import("@/app/api/semesters/[id]/session/route");
    const url = `http://localhost:3000/api/semesters/${semesterId}/session`;
    const req = new NextRequest(url);
    const res = await DELETE(req, { params: Promise.resolve({ id: semesterId }) });
    expect(res.status).toBe(400);
  });
});
