import { afterEach, describe, expect, it } from "vitest";
import { TEST_FIXTURE } from "../../scripts/test-fixture-data";
import { prisma } from "@/lib/prisma";
import {
  compactHotGenerationRecordsForClass,
  confirmLongTermMemory,
  recordSuccessfulGeneration,
  undoHotToWarmCompaction,
} from "@/services/generation-memory-service";

const extraSessionIds = [3, 4, 5, 6].map((number) => `test-memory-session-${number}`);

afterEach(async () => {
  await prisma.generationRecord.deleteMany();
  await prisma.teachingMemory.deleteMany();
  await prisma.memoryCompactionRun.deleteMany();
  await prisma.sessionMetric.deleteMany({ where: { sessionId: { in: extraSessionIds } } });
  await prisma.attendance.deleteMany({ where: { sessionId: { in: extraSessionIds } } });
  await prisma.classSession.deleteMany({ where: { id: { in: extraSessionIds } } });
});

describe("generation memory retention", () => {
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
});
