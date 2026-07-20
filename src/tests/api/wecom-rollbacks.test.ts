import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  rollbackDate: vi.fn(),
  rollbackOperation: vi.fn(),
  rollbackRun: vi.fn(),
  retryBatch: vi.fn(),
  ignoreBatch: vi.fn(),
}));

vi.mock("@/services/wecom-rollback-service", () => ({
  listWeComRollbackOperations: mocks.list,
  rollbackWeComDate: mocks.rollbackDate,
  rollbackWeComOperation: mocks.rollbackOperation,
  rollbackWeComRun: mocks.rollbackRun,
}));
vi.mock("@/services/wecom-import-ledger-service", () => ({
  retryWeComBatchCandidate: mocks.retryBatch,
  ignoreWeComBatchCandidate: mocks.ignoreBatch,
}));

import { GET, POST } from "@/app/api/system/wecom-rollbacks/route";

describe("/api/system/wecom-rollbacks", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it("lists run history and retention", async () => {
    mocks.list.mockResolvedValue({
      runs: [],
      receiptCounts: {},
      state: null,
      retention: { days: 30, runs: 30, safetyBackups: 3 },
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runs: [],
      retention: { days: 30, runs: 30, safetyBackups: 3 },
    });
  });

  it("rolls back one complete click-run", async () => {
    mocks.rollbackRun.mockResolvedValue({
      runCount: 1,
      batchCount: 2,
      communicationCount: 3,
      labelCount: 1,
    });
    const request = new NextRequest("http://localhost/api/system/wecom-rollbacks", {
      method: "POST",
      body: JSON.stringify({ action: "rollback-run", runId: "run-1" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.rollbackRun).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(await response.json()).toMatchObject({ batchCount: 2, communicationCount: 3 });
  });

  it("supports retry and ignore without exposing internal errors", async () => {
    mocks.retryBatch.mockRejectedValue(new Error("/private/path provider raw error"));
    const retry = new NextRequest("http://localhost/api/system/wecom-rollbacks", {
      method: "POST",
      body: JSON.stringify({ action: "retry-batch", batchId: "batch-1" }),
      headers: { "Content-Type": "application/json" },
    });
    const failed = await POST(retry);
    expect(failed.status).toBe(400);
    expect(JSON.stringify(await failed.json())).not.toContain("/private/path");

    mocks.ignoreBatch.mockResolvedValue({ ignored: true });
    const ignore = new NextRequest("http://localhost/api/system/wecom-rollbacks", {
      method: "POST",
      body: JSON.stringify({ action: "ignore-batch", batchId: "batch-1" }),
      headers: { "Content-Type": "application/json" },
    });
    const ignored = await POST(ignore);
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ ignored: true });
  });
});
