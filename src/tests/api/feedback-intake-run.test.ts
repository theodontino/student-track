import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/feedback/intake/runs/[id]/route";
import { prisma } from "@/lib/prisma";

describe("/api/feedback/intake/runs/[id]", () => {
  it("preserves the recycle-bin error and leaves the intake run unchanged", async () => {
    const marker = crypto.randomUUID();
    const semesterId = `api-recycled-intake-semester-${marker}`;
    const classId = `api-recycled-intake-class-${marker}`;
    const sessionCode = `api-recycled-intake-session-${marker}`;
    await prisma.semester.create({
      data: { id: semesterId, name: `API 回收投料-${marker}`, startDate: "2096-01-01", endDate: "2096-12-31" },
    });
    await prisma.class.create({
      data: { id: classId, semesterId, code: `API-RECYCLED-${marker}`, name: "API 回收投料测试班" },
    });
    await prisma.classSession.create({
      data: { code: sessionCode, date: "2096-07-08", semesterNumber: 1, semesterId, classId },
    });
    const appliedSummary = JSON.stringify({
      scopeConfirmation: { classId, sessionCode, studentIds: [], confirmedAt: "2096-07-08T10:00:00.000Z" },
    });
    const run = await prisma.feedbackIntakeRun.create({
      data: {
        sessionCode,
        sourceFingerprint: `API-RECYCLED-INTAKE-${marker}`,
        sourceManifest: "[]",
        status: "needs_review",
        issues: "[]",
        appliedSummary,
      },
    });
    await prisma.class.update({ where: { id: classId }, data: { deletedAt: new Date() } });
    const context = { params: Promise.resolve({ id: run.id }) };

    try {
      const readResponse = await GET(new NextRequest(`http://localhost/api/feedback/intake/runs/${run.id}`), context);
      expect(readResponse.status).toBe(409);
      await expect(readResponse.json()).resolves.toMatchObject({
        code: "scope_in_recycle_bin",
        retryable: false,
      });

      const writeResponse = await POST(new NextRequest(`http://localhost/api/feedback/intake/runs/${run.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_scope" }),
      }), context);
      expect(writeResponse.status).toBe(409);
      await expect(writeResponse.json()).resolves.toMatchObject({
        code: "scope_in_recycle_bin",
        retryable: false,
      });
      await expect(prisma.feedbackIntakeRun.findUniqueOrThrow({ where: { id: run.id } }))
        .resolves.toMatchObject({ appliedSummary });
    } finally {
      await prisma.class.update({ where: { id: classId }, data: { deletedAt: null } });
      await prisma.feedbackIntakeRun.delete({ where: { id: run.id } });
      await prisma.classSession.delete({ where: { code: sessionCode } });
      await prisma.class.delete({ where: { id: classId } });
      await prisma.semester.delete({ where: { id: semesterId } });
    }
  });
});
