import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as getDirectory } from "@/app/api/integrations/wecomcatch/v1/directory/route";

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
});
