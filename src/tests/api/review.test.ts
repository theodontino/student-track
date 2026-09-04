import { afterEach, describe, it, expect, vi } from "vitest";
import { GET, POST } from "@/app/api/review/route";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { processDraftReview } from "@/services/review-service";

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    const req = new NextRequest("http://localhost:3000/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "confirm" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("hides WCC drafts in Core and rejects API and direct-service processing", async () => {
    const ordinaryId = "test-core-review-visible";
    const wccId = "wcc-test-core-review-hidden";
    await prisma.draftRecord.deleteMany({ where: { id: { in: [ordinaryId, wccId] } } });
    await prisma.draftRecord.createMany({
      data: [
        { id: ordinaryId, rawText: "合成课堂草案", parsedResult: "{}" },
        { id: wccId, rawText: "合成企微草案", parsedResult: "{}" },
      ],
    });
    vi.stubEnv("NEXT_PUBLIC_STUDENT_TRACK_EDITION", "core");

    try {
      const getResponse = await GET(new NextRequest("http://localhost:3000/api/review?status=pending"));
      const drafts = await getResponse.json() as Array<{ id: string }>;
      expect(getResponse.status).toBe(200);
      expect(drafts.some((draft) => draft.id === ordinaryId)).toBe(true);
      expect(drafts.some((draft) => draft.id === wccId)).toBe(false);

      const postResponse = await POST(new NextRequest("http://localhost:3000/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: wccId, action: "reject" }),
      }));
      expect(postResponse.status).toBe(404);
      await expect(postResponse.json()).resolves.toMatchObject({
        error: "当前 Core 版未包含此功能",
        code: "feature_unavailable",
      });

      await expect(processDraftReview({ draftId: wccId, action: "confirm" })).rejects.toMatchObject({
        status: 404,
        code: "feature_unavailable",
      });
      await expect(prisma.draftRecord.findUnique({ where: { id: wccId } })).resolves.toMatchObject({ status: "pending" });
    } finally {
      await prisma.draftRecord.deleteMany({ where: { id: { in: [ordinaryId, wccId] } } });
    }
  });
});
