import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ accept: vi.fn() }));

vi.mock("@/services/wecomcatch-integration-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/wecomcatch-integration-service")>();
  return { ...original, acceptWccCandidateBatch: mocks.accept };
});

import { GET as getDirectory } from "@/app/api/integrations/wecomcatch/v1/directory/route";
import { POST as postCandidates } from "@/app/api/integrations/wecomcatch/v1/candidate-batches/route";

function request(path: string, init: RequestInit = {}) {
  return new NextRequest(`http://127.0.0.1:3000${path}`, {
    ...init,
    headers: { authorization: "Bearer test-token", "content-type": "application/json", ...(init.headers || {}) },
  });
}

describe("WCC versioned integration", () => {
  beforeEach(() => {
    vi.stubEnv("WECOMCATCH_API_TOKEN", "test-token");
    mocks.accept.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects directory access without the local integration token", async () => {
    const response = await getDirectory(new NextRequest("http://127.0.0.1:3000/api/integrations/wecomcatch/v1/directory"));
    expect(response.status).toBe(401);
  });

  it("returns only minimal versioned directory fields", async () => {
    const response = await getDirectory(request("/api/integrations/wecomcatch/v1/directory"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.version).toHaveLength(20);
    expect(body.students[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), studentId: expect.any(String), classId: expect.any(String) }));
    expect(body.students[0]).not.toHaveProperty("communications");
    expect(body.students[0]).not.toHaveProperty("scores");
  });

  it("accepts a WCC batch into pending review without applying records", async () => {
    mocks.accept.mockResolvedValue({ batchId: "pkg-1", status: "pending_review", drafts: [{ id: "wcc-1" }] });
    const response = await postCandidates(request("/api/integrations/wecomcatch/v1/candidate-batches", {
      method: "POST",
      body: JSON.stringify({ contractVersion: "wcc.student-track-candidates.v1", batchId: "pkg-1" }),
    }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ status: "pending_review" });
    expect(mocks.accept).toHaveBeenCalledOnce();
  });
});
