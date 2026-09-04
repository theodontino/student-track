import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { NextRequest } from "next/server";
import { TEST_FIXTURE } from "../../../scripts/test-fixture-data";

let studentId: string;

beforeAll(async () => {
  const s = await prisma.student.findFirst({ select: { id: true }, orderBy: { studentId: "asc" } });
  expect(s).toBeTruthy();
  studentId = s!.id;
});

describe("/api/students/[id]/history", () => {
  it("GET returns 200 with array", async () => {
    const { GET } = await import("@/app/api/students/[id]/history/route");
    const req = new NextRequest(`http://localhost:3000/api/students/${studentId}/history`);
    const res = await GET(req, { params: Promise.resolve({ id: studentId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("keeps unbound history but hides history tied to a recycled class session", async () => {
    const ids = ["test-history-active-scope", "test-history-unbound-scope"];
    await prisma.sessionMetricHistory.createMany({
      data: [
        {
          id: ids[0],
          metricId: "test-history-active-metric",
          studentId,
          date: TEST_FIXTURE.sessions[0].date,
          scoreA: 3,
          scoreB: 3,
          scoreC: 3,
          scoreD: 5,
          operator: "teacher",
          sessionId: TEST_FIXTURE.sessions[0].id,
          changeType: "update",
        },
        {
          id: ids[1],
          metricId: "test-history-unbound-metric",
          studentId,
          date: "2026-01-01",
          scoreA: 2,
          scoreB: 2,
          scoreC: 2,
          scoreD: 3,
          operator: "teacher",
          sessionId: null,
          changeType: "update",
        },
      ],
    });
    await prisma.class.update({ where: { id: TEST_FIXTURE.class.id }, data: { deletedAt: new Date() } });

    try {
      const { GET } = await import("@/app/api/students/[id]/history/route");
      const response = await GET(
        new NextRequest(`http://localhost:3000/api/students/${studentId}/history`),
        { params: Promise.resolve({ id: studentId }) },
      );
      const body = await response.json() as Array<{ id: string }>;
      expect(body.map((item) => item.id)).not.toContain(ids[0]);
      expect(body.map((item) => item.id)).toContain(ids[1]);
    } finally {
      await prisma.class.update({ where: { id: TEST_FIXTURE.class.id }, data: { deletedAt: null } });
      await prisma.sessionMetricHistory.deleteMany({ where: { id: { in: ids } } });
    }
  });
});
