import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  confirm: vi.fn(),
  drafts: vi.fn(),
  memories: vi.fn(),
  history: vi.fn(),
  undo: vi.fn(),
  teachingMemoryFindMany: vi.fn(),
  classFindMany: vi.fn(),
  runFindMany: vi.fn(),
  studentFindMany: vi.fn(),
}));

vi.mock("@/services/generation-memory-service", () => ({
  compactHotGenerationRecordsForClass: mocks.compact,
  confirmLongTermMemory: mocks.confirm,
  generateLongTermMemoryDraftsForClass: mocks.drafts,
  getConfirmedTeachingMemory: mocks.memories,
  listGenerationHistory: mocks.history,
  undoHotToWarmCompaction: mocks.undo,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teachingMemory: { findMany: mocks.teachingMemoryFindMany },
    class: { findMany: mocks.classFindMany },
    memoryCompactionRun: { findMany: mocks.runFindMany },
    student: { findMany: mocks.studentFindMany },
  },
}));

import { GET, PATCH, POST } from "@/app/api/teaching-memory/route";

function jsonRequest(method: "POST" | "PATCH", body: unknown) {
  return new NextRequest("http://127.0.0.1:3000/api/teaching-memory", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/teaching-memory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memories.mockResolvedValue([]);
    mocks.history.mockResolvedValue([]);
    mocks.teachingMemoryFindMany.mockResolvedValue([]);
    mocks.classFindMany.mockResolvedValue([{ id: "class-1", code: "C1", name: "合成班级" }]);
    mocks.runFindMany.mockResolvedValue([]);
    mocks.studentFindMany.mockResolvedValue([]);
  });

  it("exposes class operations and undoable compaction runs to the existing history workspace", async () => {
    mocks.runFindMany.mockResolvedValue([{
      id: "run-1",
      classId: "class-1",
      phase: "hot-to-warm",
      status: "succeeded",
      affectedCount: 3,
      rollbackPayload: "[]",
      undoUntil: new Date("2026-08-01T00:00:00.000Z"),
      completedAt: new Date("2026-07-29T00:00:00.000Z"),
    }]);

    const response = await GET(new NextRequest("http://127.0.0.1:3000/api/teaching-memory?operations=1"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      classes: [{ id: "class-1", code: "C1", name: "合成班级" }],
      undoableRuns: [{ id: "run-1", classId: "class-1", className: "合成班级", affectedCount: 3 }],
    });
    expect(mocks.runFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ phase: "hot-to-warm", status: "succeeded" }),
    }));
  });

  it("triggers long-term drafts for the selected class and preserves controlled skip details", async () => {
    mocks.drafts.mockResolvedValue({
      drafts: 0,
      skipped: true,
      reason: "no_reliable_semester_summary",
      runId: null,
      skippedScopes: 1,
    });

    const response = await POST(jsonRequest("POST", { action: "long-term-drafts", classId: "class-1" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      drafts: 0,
      skipped: true,
      reason: "no_reliable_semester_summary",
    });
    expect(mocks.drafts).toHaveBeenCalledWith("class-1", expect.anything());
  });

  it("makes undo and teacher confirmation reachable through validated API actions", async () => {
    mocks.undo.mockResolvedValue(undefined);
    mocks.confirm.mockResolvedValue({ id: "memory-1", status: "confirmed", content: "教师确认内容" });

    const undoResponse = await POST(jsonRequest("POST", { action: "undo", runId: "run-1" }));
    expect(undoResponse.status).toBe(200);
    await expect(undoResponse.json()).resolves.toEqual({ success: true });
    expect(mocks.undo).toHaveBeenCalledWith("run-1", expect.anything());

    const confirmResponse = await PATCH(jsonRequest("PATCH", { id: "memory-1", content: "教师确认内容" }));
    expect(confirmResponse.status).toBe(200);
    await expect(confirmResponse.json()).resolves.toMatchObject({ id: "memory-1", status: "confirmed" });
    expect(mocks.confirm).toHaveBeenCalledWith("memory-1", "教师确认内容", expect.anything());
  });

  it("rejects malformed retention actions without calling a service", async () => {
    const response = await POST(jsonRequest("POST", { action: "long-term-drafts", classId: "" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
    expect(mocks.drafts).not.toHaveBeenCalled();
    expect(mocks.undo).not.toHaveBeenCalled();
  });
});
