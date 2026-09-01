import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";

let semesterId: string;
let classId: string;
const marker = `session-route-${Date.now()}`;

beforeAll(async () => {
  const semester = await prisma.semester.create({
    data: {
      name: marker,
      startDate: "2099-01-01",
      endDate: "2099-12-31",
    },
  });
  semesterId = semester.id;
  const classRecord = await prisma.class.create({
    data: { semesterId, code: `${marker}-01`, name: "合成测试班" },
  });
  classId = classRecord.id;
});

afterAll(async () => {
  await prisma.classSession.deleteMany({ where: { semesterId } });
  await prisma.class.deleteMany({ where: { semesterId } });
  await prisma.semester.deleteMany({ where: { id: semesterId } });
});

describe("/api/semesters/[id]/session", () => {
  it("GET previews an ungrouped class and POST creates its requested date", async () => {
    const { GET, POST, DELETE } = await import("@/app/api/semesters/[id]/session/route");
    const previewRequest = new NextRequest(
      `http://localhost:3000/api/semesters/${semesterId}/session?classId=${classId}&date=2099-11-18`,
    );
    const previewResponse = await GET(previewRequest, { params: Promise.resolve({ id: semesterId }) });
    expect(previewResponse.status).toBe(200);
    await expect(previewResponse.json()).resolves.toMatchObject({
      date: "2099-11-18",
      class: { id: classId },
      group: null,
      recommendation: { type: "independent" },
    });

    const req = new NextRequest(`http://localhost:3000/api/semesters/${semesterId}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId, date: "2099-11-18", requestKey: `${marker}-create` }),
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

  it("replays the same request without creating a second session", async () => {
    const { POST } = await import("@/app/api/semesters/[id]/session/route");
    const url = `http://localhost:3000/api/semesters/${semesterId}/session`;
    const requestKey = `${marker}-retry`;
    const makeRequest = (date: string) => new NextRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId, date, requestKey }),
    });

    const firstResponse = await POST(makeRequest("2099-11-19"), { params: Promise.resolve({ id: semesterId }) });
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json();

    const replayResponse = await POST(makeRequest("2099-11-19"), { params: Promise.resolve({ id: semesterId }) });
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toMatchObject({
      id: first.id,
      code: first.code,
      idempotentReplay: true,
    });
    expect(await prisma.classSession.count({ where: { creationRequestKey: requestKey } })).toBe(1);

    const conflictResponse = await POST(makeRequest("2099-11-20"), { params: Promise.resolve({ id: semesterId }) });
    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({ error: expect.stringContaining("同一建课请求") });
  });

  it("requires an idempotency key for API creation", async () => {
    const { POST } = await import("@/app/api/semesters/[id]/session/route");
    const req = new NextRequest(`http://localhost:3000/api/semesters/${semesterId}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classId, date: "2099-11-21" }),
    });
    const response = await POST(req, { params: Promise.resolve({ id: semesterId }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("requestKey") });
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
