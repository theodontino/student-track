import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ completionCreate: vi.fn() }));

vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  createLLMClient: (_role?: string, profileId?: string) => ({
    profileId,
    chat: { completions: { create: mocks.completionCreate } },
  }),
  getLLMModel: (_role?: string, profileId?: string) => `model-${profileId ?? "default"}`,
  getLLMCompletionOptions: (_role: unknown, maxTokens: number) => ({ max_tokens: maxTokens }),
}));

import { TEST_FIXTURE } from "../../scripts/test-fixture-data";
import { clearLLMSettings, getLLMSettingsStore, saveLLMProfile } from "@/lib/llm-settings";
import { prisma } from "@/lib/prisma";
import {
  feedbackContextFingerprint,
  listFeedbackVersions,
  regenerateFeedbackVersions,
  selectFeedbackVersion,
} from "@/services/feedback-version-service";
import { buildFeedbackContext } from "@/services/feedback-context-service";

const inputRevision = "version-input-1";
let sourceGenerationId = "";
let historyId = "";
let firstProfileId = "";
let secondProfileId = "";

beforeEach(async () => {
  clearLLMSettings();
  const first = saveLLMProfile({
    name: "主配置",
    apiBaseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "secret-a",
    model: "model-a",
    maxTokens: 2048,
  }, true);
  firstProfileId = first.activeProfileId!;
  const second = saveLLMProfile({
    name: "派生配置",
    apiBaseUrl: "http://127.0.0.1:1235/v1",
    apiKey: "secret-b",
    model: "model-b",
    maxTokens: 4096,
  }, false);
  secondProfileId = second.profiles.find((profile) => profile.name === "派生配置")!.id;
  const replay = {
    version: 1,
    studentName: TEST_FIXTURE.students[0].name,
    promptContext: "固定合成证据：该生本节课完成了课堂任务。",
    forbiddenStudentNames: [TEST_FIXTURE.students[1].name],
    style: "balanced",
    length: "short",
    intensity: "routine",
    contextFingerprint: feedbackContextFingerprint(
      (await buildFeedbackContext(prisma, TEST_FIXTURE.sessions[0].code))
        .students.find((student) => student.id === TEST_FIXTURE.students[0].id)!.promptContext,
    ),
  };
  const source = await prisma.generationRecord.create({
    data: {
      taskType: "feedback",
      stage: "routine",
      semesterId: TEST_FIXTURE.semester.id,
      classId: TEST_FIXTURE.class.id,
      sessionId: TEST_FIXTURE.sessions[0].id,
      studentId: TEST_FIXTURE.students[0].id,
      sourceRefs: "[]",
      sourceFingerprint: "feedback-version-source",
      promptVersion: "feedback-composable-v2",
      modelName: "model-a",
      modelRole: "feedbackReview",
      modelProfileId: firstProfileId,
      modelSettings: "{}",
      inputRevision,
      inputSnapshot: JSON.stringify(replay),
      outputSnapshot: JSON.stringify({ reviewStatus: "passed", modelRawFinalText: "原始版本" }),
      finalText: "原始版本",
      variantKey: "feedback-version-source-key",
    },
  });
  sourceGenerationId = source.id;
  await prisma.feedbackGenerationSelection.create({
    data: {
      sessionId: TEST_FIXTURE.sessions[0].id,
      studentId: TEST_FIXTURE.students[0].id,
      selectedGenerationId: source.id,
    },
  });
  const history = await prisma.workHistory.create({
    data: {
      module: "feedback",
      key: TEST_FIXTURE.sessions[0].code,
      title: "版本测试",
      state: JSON.stringify({ inputRevision }),
    },
  });
  historyId = history.id;
  mocks.completionCreate.mockResolvedValue({
    choices: [{
      message: {
        content: JSON.stringify({
          verdict: "pass",
          feedback: "学".repeat(60),
          issues: [],
        }),
      },
    }],
  });
});

afterEach(async () => {
  mocks.completionCreate.mockReset();
  await prisma.feedbackGenerationSelection.deleteMany({
    where: { sessionId: TEST_FIXTURE.sessions[0].id, studentId: TEST_FIXTURE.students[0].id },
  });
  await prisma.generationRecord.deleteMany({
    where: {
      studentId: TEST_FIXTURE.students[0].id,
      OR: [{ id: sourceGenerationId }, { parentGenerationId: sourceGenerationId }],
    },
  });
  if (historyId) await prisma.workHistory.deleteMany({ where: { id: historyId } });
  clearLLMSettings();
});

describe("feedback version service", () => {
  it("uses an explicit profile without changing the active profile and deduplicates variants", async () => {
    const first = await regenerateFeedbackVersions({
      profileId: secondProfileId,
      items: [{
        studentId: TEST_FIXTURE.students[0].id,
        sourceGenerationId,
      }],
    });
    const second = await regenerateFeedbackVersions({
      profileId: secondProfileId,
      items: [{
        studentId: TEST_FIXTURE.students[0].id,
        sourceGenerationId,
      }],
    });
    const changedExpression = await regenerateFeedbackVersions({
      profileId: secondProfileId,
      items: [{
        studentId: TEST_FIXTURE.students[0].id,
        sourceGenerationId,
        style: "professional",
        length: "short",
      }],
    });
    expect(first.results[0]).toMatchObject({ status: "created" });
    expect(second.results[0]).toMatchObject({
      status: "existing",
      generationId: first.results[0]?.generationId,
    });
    expect(changedExpression.results[0]).toMatchObject({ status: "created" });
    const changedRecord = await prisma.generationRecord.findUniqueOrThrow({
      where: { id: String(changedExpression.results[0]?.generationId) },
    });
    expect(JSON.parse(changedRecord.inputSnapshot ?? "{}")).toMatchObject({
      style: "professional",
      length: "short",
    });
    expect(mocks.completionCreate).toHaveBeenCalledTimes(2);
    expect(getLLMSettingsStore().activeProfileId).toBe(firstProfileId);

    const newerSingleHistory = await prisma.workHistory.create({
      data: {
        module: "feedback",
        key: TEST_FIXTURE.sessions[0].code,
        title: "较新的单人反馈",
        state: JSON.stringify({ kind: "single", feedback: "不应遮蔽批次输入修订" }),
      },
    });
    const beforeSelection = await listFeedbackVersions({
      sessionCode: TEST_FIXTURE.sessions[0].code,
      studentId: TEST_FIXTURE.students[0].id,
    });
    await prisma.workHistory.delete({ where: { id: newerSingleHistory.id } });
    expect(beforeSelection.versions.find((version) => version.id === sourceGenerationId)?.selected).toBe(true);
    expect(beforeSelection.versions.find((version) => version.id === first.results[0]?.generationId)?.selected).toBe(false);

    await selectFeedbackVersion({
      sessionCode: TEST_FIXTURE.sessions[0].code,
      studentId: TEST_FIXTURE.students[0].id,
      generationId: String(first.results[0]?.generationId),
    });
    const afterSelection = await listFeedbackVersions({
      sessionCode: TEST_FIXTURE.sessions[0].code,
      studentId: TEST_FIXTURE.students[0].id,
    });
    expect(afterSelection.versions.find((version) => version.id === first.results[0]?.generationId)?.selected).toBe(true);
  });

  it("keeps 1.0 records read-only when replay input is absent", async () => {
    const legacy = await prisma.generationRecord.create({
      data: {
        taskType: "feedback",
        stage: "routine",
        sessionId: TEST_FIXTURE.sessions[0].id,
        studentId: TEST_FIXTURE.students[1].id,
        sourceRefs: "[]",
        sourceFingerprint: "feedback-version-legacy",
        promptVersion: "feedback-composable-v1",
        modelName: "legacy",
        modelSettings: "{}",
        outputSnapshot: "{}",
        finalText: "旧文本",
      },
    });
    try {
      const listed = await listFeedbackVersions({
        sessionCode: TEST_FIXTURE.sessions[0].code,
        studentId: TEST_FIXTURE.students[1].id,
      });
      expect(listed.versions[0]).toMatchObject({
        id: legacy.id,
        replayable: false,
        replayState: "缺少可重放输入",
      });
      await expect(selectFeedbackVersion({
        sessionCode: TEST_FIXTURE.sessions[0].code,
        studentId: TEST_FIXTURE.students[1].id,
        generationId: legacy.id,
      })).rejects.toMatchObject({ status: 409 });
    } finally {
      await prisma.generationRecord.delete({ where: { id: legacy.id } });
    }
  });

  it("isolates per-student regeneration failures inside a batch", async () => {
    const result = await regenerateFeedbackVersions({
      profileId: secondProfileId,
      items: [
        {
          studentId: TEST_FIXTURE.students[0].id,
          sourceGenerationId,
        },
        {
          studentId: TEST_FIXTURE.students[1].id,
          sourceGenerationId: "missing-generation",
        },
      ],
    });
    expect(result.results).toEqual([
      expect.objectContaining({
        studentId: TEST_FIXTURE.students[0].id,
        status: "created",
      }),
      expect.objectContaining({
        studentId: TEST_FIXTURE.students[1].id,
        status: "error",
        code: "not_found",
      }),
    ]);
    expect(mocks.completionCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses to replay a version after the persisted input revision changes", async () => {
    await prisma.workHistory.update({
      where: { id: historyId },
      data: { state: JSON.stringify({ inputRevision: "newer-input-revision" }) },
    });
    const result = await regenerateFeedbackVersions({
      profileId: secondProfileId,
      items: [{
        studentId: TEST_FIXTURE.students[0].id,
        sourceGenerationId,
      }],
    });
    expect(result.results[0]).toMatchObject({
      status: "error",
      code: "conflict",
      error: expect.stringContaining("当前输入已变化"),
    });
    expect(mocks.completionCreate).not.toHaveBeenCalled();
  });
});
