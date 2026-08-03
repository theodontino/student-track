import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as getDirectory } from "@/app/api/integrations/wecomcatch/v1/directory/route";
import { prisma } from "@/lib/prisma";
import { TEST_FIXTURE } from "../../../scripts/test-fixture-data";

function request(path: string, init: RequestInit = {}) {
  return new NextRequest(`http://127.0.0.1:3000${path}`, {
    ...init,
    signal: init.signal ?? undefined,
    headers: { authorization: "Bearer test-token", "content-type": "application/json", ...(init.headers || {}) },
  });
}

describe("WCC versioned integration", () => {
  beforeEach(() => {
    vi.stubEnv("WECOMCATCH_API_TOKEN", "test-token");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await prisma.studentClassEnrollment.update({
      where: { studentId_semesterId: { studentId: TEST_FIXTURE.students[0].id, semesterId: TEST_FIXTURE.semester.id } },
      data: { rosterStatus: "ACTIVE", statusEffectiveAt: new Date() },
    });
  });

  it("rejects directory access without the local integration token", async () => {
    const response = await getDirectory(new NextRequest("http://127.0.0.1:3000/api/integrations/wecomcatch/v1/directory"));
    expect(response.status).toBe(401);
  });

  it("returns only minimal versioned directory fields", async () => {
    const response = await getDirectory(request("/api/integrations/wecomcatch/v1/directory"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.version).toHaveLength(20);
    expect(body.capabilities).toContain("handoff-revisions-v1");
    expect(body.students[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), studentId: expect.any(String), classId: expect.any(String) }));
    expect(body.students[0]).not.toHaveProperty("communications");
    expect(body.students[0]).not.toHaveProperty("scores");
  });

  it("excludes inactive students from the current WCG roster without deleting them", async () => {
    await prisma.studentClassEnrollment.update({
      where: { studentId_semesterId: { studentId: TEST_FIXTURE.students[0].id, semesterId: TEST_FIXTURE.semester.id } },
      data: { rosterStatus: "INACTIVE", statusEffectiveAt: new Date() },
    });
    const response = await getDirectory(request("/api/integrations/wecomcatch/v1/directory"));
    const body = await response.json();
    expect(body.students).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: TEST_FIXTURE.students[0].id }),
    ]));
    await expect(prisma.studentClassEnrollment.findUniqueOrThrow({
      where: { studentId_semesterId: { studentId: TEST_FIXTURE.students[0].id, semesterId: TEST_FIXTURE.semester.id } },
    })).resolves.toMatchObject({ rosterStatus: "INACTIVE" });
  });
});
