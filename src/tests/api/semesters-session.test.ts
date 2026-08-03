import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

let semesterId: string;

beforeAll(async () => {
  const sem = await prisma.semester.findFirst({ select: { id: true } });
  semesterId = sem!.id;
});

describe("/api/semesters/[id]/session", () => {
  it("POST creates a class session for the requested date", async () => {
    const { POST, DELETE } = await import("@/app/api/semesters/[id]/session/route");
    const classRecord = await prisma.class.findFirst({ where: { semesterId }, select: { code: true } });
    const req = new NextRequest(`http://localhost:3000/api/semesters/${semesterId}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classCode: classRecord!.code, date: "2099-11-18" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: semesterId }) });
    expect(res.status).toBe(201);
    const session = await res.json();
    expect(session).toMatchObject({ date: "2099-11-18" });

    const deleteReq = new NextRequest(
      `http://localhost:3000/api/semesters/${semesterId}/session?code=${session.code}`,
      { method: "DELETE" },
    );
    await expect(DELETE(deleteReq, { params: Promise.resolve({ id: semesterId }) })).resolves.toMatchObject({ status: 200 });
  });

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
