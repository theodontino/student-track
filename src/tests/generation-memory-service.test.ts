import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completionCreate: vi.fn(),
}));

vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  createLLMClient: () => ({ chat: { completions: { create: mocks.completionCreate } } }),
  getLLMModel: () => "test-memory-model",
  getLLMCompletionOptions: (_role: unknown, maxTokens: number) => ({ max_tokens: maxTokens }),
}));

import { TEST_FIXTURE } from "../../scripts/test-fixture-data";
import { prisma } from "@/lib/prisma";
import {
  compactHotGenerationRecordsForClass,
  confirmLongTermMemory,
  generateLongTermMemoryDraftsForClass,
  recordSuccessfulGeneration,
  undoHotToWarmCompaction,
} from "@/services/generation-memory-service";

const extraSessionIds = [3, 4, 5, 6].map((number) => `test-memory-session-${number}`);
const oldSessionIds = ["draft", "missing", "failure"].map((suffix) => `test-memory-old-${suffix}`);

async function createOldWarmRecord(suffix: "draft" | "missing" | "failure", summary?: unknown) {
  const sessionId = `test-memory-old-${suffix}`;
  await prisma.classSession.create({
    data: {
      id: sessionId,
      code: `2025010${suffix === "draft" ? "1" : suffix === "missing" ? "2" : "3"}01`,
      date: `2025-01-0${suffix === "draft" ? "1" : suffix === "missing" ? "2" : "3"}`,
      semesterId: TEST_FIXTURE.semester.id,
      classId: TEST_FIXTURE.class.id,
      semesterNumber: suffix === "draft" ? 30 : suffix === "missing" ? 31 : 32,
    },
  });
  const record = await prisma.generationRecord.create({
    data: {
      taskType: "feedback",
      stage: "routine",
      lifecycle: "warm",
      semesterId: TEST_FIXTURE.semester.id,
      classId: TEST_FIXTURE.class.id,
      sessionId,
      studentId: TEST_FIXTURE.students[0].id,
      sourceRefs: JSON.stringify([{ type: "session", id: sessionId }]),
      sourceFingerprint: `test-warm-${suffix}`,
      promptVersion: "test-v1",
      modelName: "test",
      modelSettings: "{}",
      warmSnapshot: JSON.stringify({ version: 1, compactedFrom: [sessionId], recordCount: 1 }),
    },
  });
  if (summary !== undefined) {
    await prisma.teachingMemory.create({
      data: {
        scopeType: "student",
        scopeId: TEST_FIXTURE.students[0].id,
        semesterKey: `semester:${TEST_FIXTURE.semester.id}`,
        semesterId: TEST_FIXTURE.semester.id,
        memoryTier: "semester",
        status: "confirmed",
        content: JSON.stringify({
          version: 1,
          items: [{
            generationId: record.id,
            sessionId,
            taskType: "feedback",
            stage: "routine",
            generatedAt: new Date("2025-01-05T00:00:00.000Z").toISOString(),
            adopted: true,
            summary,
          }],
        }),
        sourceRefs: JSON.stringify([{ type: "session", id: sessionId }]),
        sourceFingerprint: `test-semester-${suffix}`,
        effectiveThrough: sessionId,
      },
    });
  }
  return record;
}

afterEach(async () => {
  mocks.completionCreate.mockReset();
  await prisma.generationRecord.deleteMany();
  await prisma.teachingMemory.deleteMany();
  await prisma.memoryCompactionRun.deleteMany();
  const createdSessionIds = [...extraSessionIds, ...oldSessionIds];
  await prisma.sessionMetric.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  await prisma.attendance.deleteMany({ where: { sessionId: { in: createdSessionIds } } });
  await prisma.classSession.deleteMany({ where: { id: { in: createdSessionIds } } });
});

describe("generation memory retention", () => {
  it("selects each new primary feedback generation but never an explicit derived variant", async () => {
    const shared = {
      taskType: "feedback" as const,
      stage: "routine",
      semesterId: TEST_FIXTURE.semester.id,
      classId: TEST_FIXTURE.class.id,
      sessionId: TEST_FIXTURE.sessions[0].id,
      studentId: TEST_FIXTURE.students[0].id,
      sourceRefs: [{ type: "session" as const, id: TEST_FIXTURE.sessions[0].id }],
      promptVersion: "test-selection-v1",
      finalText: "学".repeat(90),
    };
    const first = await recordSuccessfulGeneration({
      ...shared,
      variantKey: "test-primary-version-1",
      inputRevision: "input-1",
      inputSnapshot: { revision: 1 },
      outputSnapshot: { revision: 1 },
    });
    const second = await recordSuccessfulGeneration({
      ...shared,
      variantKey: "test-primary-version-2",
      inputRevision: "input-2",
      inputSnapshot: { revision: 2 },
      outputSnapshot: { revision: 2 },
    });
    const derived = await recordSuccessfulGeneration({
      ...shared,
      variantKey: "test-derived-version",
      inputRevision: "input-2",
      parentGenerationId: second.id,
      selectIfFirst: false,
      inputSnapshot: { revision: 2 },
      outputSnapshot: { revision: 2, derived: true },
    });
    await prisma.feedbackGenerationSelection.update({
      where: {
        sessionId_studentId: {
          sessionId: TEST_FIXTURE.sessions[0].id,
          studentId: TEST_FIXTURE.students[0].id,
        },
      },
      data: { selectedGenerationId: derived.id },
    });
    await recordSuccessfulGeneration({
      ...shared,
      variantKey: "test-primary-version-2",
      inputRevision: "input-2",
      inputSnapshot: { revision: 2 },
      outputSnapshot: { revision: 2 },
    });
    await expect(prisma.feedbackGenerationSelection.findUniqueOrThrow({
      where: {
        sessionId_studentId: {
          sessionId: TEST_FIXTURE.sessions[0].id,
          studentId: TEST_FIXTURE.students[0].id,
        },
      },
    })).resolves.toMatchObject({ selectedGenerationId: second.id });
    expect(first.id).not.toBe(second.id);
  });

  it("keeps the latest five completed sessions hot, compacts older adopted output, and can undo", async () => {
    for (let index = 0; index < extraSessionIds.length; index += 1) {
      const number = index + 3;
      const id = extraSessionIds[index]!;
      await prisma.classSession.create({
        data: {
          id,
          code: `test-memory-code-${number}`,
          date: `2026-07-${String(9 + index).padStart(2, "0")}`,
          semesterId: TEST_FIXTURE.semester.id,
          classId: TEST_FIXTURE.class.id,
          semesterNumber: number,
        },
      });
      await prisma.attendance.create({ data: { sessionId: id, studentId: TEST_FIXTURE.students[0].id, present: true } });
    }
    const record = await recordSuccessfulGeneration({
      taskType: "feedback",
      stage: "routine",
      semesterId: TEST_FIXTURE.semester.id,
      classId: TEST_FIXTURE.class.id,
      sessionId: TEST_FIXTURE.sessions[0].id,
      studentId: TEST_FIXTURE.students[0].id,
      sourceRefs: [{ type: "session", id: TEST_FIXTURE.sessions[0].id }],
      promptVersion: "test-v1",
      inputSnapshot: { facts: "synthetic" },
      outputSnapshot: { text: "synthetic output" },
      finalText: "synthetic final",
    });
    await prisma.generationRecord.update({ where: { id: record.id }, data: { adoptedAt: new Date() } });

    const compacted = await compactHotGenerationRecordsForClass(TEST_FIXTURE.class.id);
    expect(compacted.compacted).toBeGreaterThanOrEqual(1);
    expect(await prisma.generationRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      lifecycle: "warm", inputSnapshot: null, outputSnapshot: null, finalText: null,
    });
    expect(await prisma.teachingMemory.count({ where: { memoryTier: "semester" } })).toBeGreaterThanOrEqual(1);

    await undoHotToWarmCompaction(compacted.runId!);
    expect(await prisma.generationRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      lifecycle: "hot", finalText: "synthetic final",
    });
    const memories = await prisma.teachingMemory.findMany({ where: { memoryTier: "semester" } });
    expect(memories.some((memory) => memory.content.includes(record.id))).toBe(false);
  });

  it("only purges warm details after a teacher confirms the related long-term background", async () => {
    const record = await prisma.generationRecord.create({
      data: {
        taskType: "feedback", stage: "routine", lifecycle: "warm",
        semesterId: TEST_FIXTURE.semester.id, classId: TEST_FIXTURE.class.id,
        sessionId: TEST_FIXTURE.sessions[0].id, studentId: TEST_FIXTURE.students[0].id,
        sourceRefs: "[]", sourceFingerprint: "test-warm", promptVersion: "test-v1",
        modelName: "test", modelSettings: "{}", warmSnapshot: "{\"summary\":\"synthetic\"}",
      },
    });
    const memory = await prisma.teachingMemory.create({
      data: {
        scopeType: "student", scopeId: TEST_FIXTURE.students[0].id, semesterKey: "long-term",
        memoryTier: "long-term", status: "draft", content: "synthetic long-term background",
        sourceRefs: JSON.stringify([{ type: "generation", id: record.id }]), sourceFingerprint: "test-long",
      },
    });
    await confirmLongTermMemory(memory.id, "confirmed synthetic background");
    expect(await prisma.generationRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      lifecycle: "purged", warmSnapshot: null,
    });
    expect(await prisma.teachingMemory.findUniqueOrThrow({ where: { id: memory.id } })).toMatchObject({
      status: "confirmed", content: "confirmed synthetic background",
    });
  });

  it("uses controlled semester summaries for long-term drafts and processes the same evidence once", async () => {
    const record = await createOldWarmRecord("draft", {
      overview: "受控学期摘要：氧化还原反应的证据表达逐步稳定。",
      status: "confirmed",
    });
    mocks.completionCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ items: [{ ref: "M001", text: "氧化还原反应的证据表达逐步稳定。" }] }) } }],
    });

    const first = await generateLongTermMemoryDraftsForClass(TEST_FIXTURE.class.id);
    expect(first).toMatchObject({ drafts: 1, skipped: false, skippedScopes: 0 });
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
    const request = mocks.completionCreate.mock.calls[0]?.[0];
    expect(request.messages[1].content).toContain("受控学期摘要：氧化还原反应的证据表达逐步稳定。");
    expect(request.messages[1].content).not.toContain("\"snapshot\":{\"version\":1");

    const draft = await prisma.teachingMemory.findFirstOrThrow({ where: { memoryTier: "long-term" } });
    expect(JSON.parse(draft.sourceRefs)).toEqual(expect.arrayContaining([
      { type: "generation", id: record.id },
      { type: "session", id: record.sessionId },
    ]));
    expect(await prisma.memoryCompactionRun.findUniqueOrThrow({ where: { id: first.runId! } })).toMatchObject({
      phase: "warm-to-long",
      status: "succeeded",
      affectedCount: 1,
    });

    const second = await generateLongTermMemoryDraftsForClass(TEST_FIXTURE.class.id);
    expect(second).toMatchObject({ drafts: 0, skipped: true, reason: "already_processed", runId: first.runId });
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);

    await confirmLongTermMemory(draft.id, "教师确认后的长期背景");
    expect(await prisma.generationRecord.findUniqueOrThrow({ where: { id: record.id } })).toMatchObject({
      lifecycle: "purged",
      warmSnapshot: null,
    });
  });

  it("skips long-term generation when no controlled semester summary exists", async () => {
    await createOldWarmRecord("missing");

    await expect(generateLongTermMemoryDraftsForClass(TEST_FIXTURE.class.id)).resolves.toMatchObject({
      drafts: 0,
      skipped: true,
      reason: "no_reliable_semester_summary",
      skippedScopes: 1,
    });
    expect(mocks.completionCreate).not.toHaveBeenCalled();
    expect(await prisma.teachingMemory.count({ where: { memoryTier: "long-term" } })).toBe(0);
    expect(await prisma.memoryCompactionRun.count({ where: { phase: "warm-to-long" } })).toBe(0);
  });

  it("records a controlled failed run when the long-term model result is invalid", async () => {
    await createOldWarmRecord("failure", { overview: "合成的可靠学期摘要" });
    mocks.completionCreate.mockResolvedValue({ choices: [{ message: { content: "{\"items\":[]}" } }] });

    await expect(generateLongTermMemoryDraftsForClass(TEST_FIXTURE.class.id)).rejects.toThrow("long_term_memory_invalid");
    expect(await prisma.memoryCompactionRun.findFirstOrThrow({ where: { phase: "warm-to-long" } })).toMatchObject({
      status: "failed",
      failureCode: "long_term_memory_invalid",
    });
    expect(await prisma.teachingMemory.count({ where: { memoryTier: "long-term" } })).toBe(0);
  });

  it("does not refill a warm or purged record when the same successful generation is recorded again", async () => {
    const input = {
      taskType: "feedback" as const,
      stage: "routine",
      semesterId: TEST_FIXTURE.semester.id,
      classId: TEST_FIXTURE.class.id,
      sessionId: TEST_FIXTURE.sessions[0].id,
      studentId: TEST_FIXTURE.students[0].id,
      sourceRefs: [{ type: "session" as const, id: TEST_FIXTURE.sessions[0].id }],
      promptVersion: "test-v1",
      inputSnapshot: { facts: "synthetic" },
      outputSnapshot: { overview: "synthetic output" },
    };
    const archived = await recordSuccessfulGeneration(input);
    await prisma.generationRecord.update({
      where: { id: archived.id },
      data: { lifecycle: "warm", inputSnapshot: null, outputSnapshot: null, warmSnapshot: "{\"version\":1}" },
    });

    const fresh = await recordSuccessfulGeneration(input);
    expect(fresh.id).not.toBe(archived.id);
    expect(fresh.lifecycle).toBe("hot");
    expect(await prisma.generationRecord.findUniqueOrThrow({ where: { id: archived.id } })).toMatchObject({
      lifecycle: "warm",
      inputSnapshot: null,
      outputSnapshot: null,
    });
  });
});
