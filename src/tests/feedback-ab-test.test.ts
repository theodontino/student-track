import { describe, expect, it, vi } from "vitest";
import { FeedbackEvidenceBundleSchema } from "@/lib/feedback-plan";
import {
  buildCurrentGenerationInput,
  buildFrozenExperimentInput,
  buildPlannerInput,
  buildRestrictedWriterInput,
  runFeedbackAbTest,
  type FeedbackAbTestDb,
  type FeedbackAbTestPlanRecord,
  type FeedbackAbTestResult,
  type FrozenExperimentInput,
} from "@/services/feedback-ab-test-service";
import { createLLMClient } from "@/lib/llm";
import { generateFeedbackPlanComposition } from "@/services/feedback-generation-service";
import { BLIND_SIDE_LABELS, formatTokenValue, outputForBlindSide } from "@/features/feedback-demo/feedback-ab-test-ui";

const lessonMaterial = {
  version: 1 as const,
  groupFeedbackRaw: "",
  assessmentBriefRaw: "",
  lessonTitle: "测试课程",
  classroomContent: [],
  classroomFocus: [],
  classroomExplanation: [],
  homework: [],
  assessmentFocus: [],
  correctionAdvice: [],
  otherNotes: [],
};

function makeEvidence() {
  return FeedbackEvidenceBundleSchema.parse({
    version: 2,
    planType: "event_micro",
    studentId: "student-test-1",
    teachingEvidence: [{ id: "present-1", kind: "fact", content: "本次能够独立完成同类题", sourceRefs: [{ type: "event", id: "event-test-1" }], confirmed: true }],
    assessmentEvidence: [],
    communicationContext: [{ id: "context-1", kind: "fact", content: "家长原始沟通秘密内容", sourceRefs: [{ type: "communication", id: "communication-test-1" }], confirmed: true }],
    teachingBackground: [],
    historySnapshot: null,
    executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
    sourceRefs: [{ type: "student", id: "student-test-1" }],
    sourceFingerprint: "frozen-evidence-test-123",
  });
}

function makePlan() {
  const evidence = makeEvidence();
  const inputSnapshot = JSON.stringify({
    version: 2,
    semesterId: "semester-test-1",
    classId: "class-test-1",
    sessionId: "session-test-1",
    rangeEndSessionId: "session-test-1",
    sessionCode: "TEST-1",
    sourceFingerprint: "frozen-input-test-123",
    lessonMaterial,
    generationPreferences: { closureType: "positive_recognition", moduleKeys: ["observed_moment", "teacher_interpretation"] },
    selectedStudentIds: ["student-test-1"],
    studentOverrides: [],
    factSnapshot: {
      capturedAt: "2099-01-01T00:00:00.000Z",
      items: [{ studentId: "student-test-1", studentName: "测试学生", studentNumber: "S-001", referenceDate: "2099-01-01", communicationPreference: null, evidence }],
    },
    intakeSources: [],
  });
  return {
    id: "plan-test-1",
    displayName: "测试计划",
    type: "event_micro",
    outputRequirement: "写给家长的简短反馈",
    generationMode: "standard",
    inputSnapshot,
    archivedAt: null,
    session: { date: "2099-01-01" },
    rangeEndSession: { date: "2099-01-01" },
    items: [{ id: "item-test-1", studentId: "student-test-1", status: "needs_review", evidenceSnapshot: JSON.stringify(evidence), generationConfigSnapshot: "{}", student: { name: "测试学生", studentId: "S-001" } }],
  } satisfies FeedbackAbTestPlanRecord;
}

function makeFrozenInput(): FrozenExperimentInput {
  const plan = makePlan();
  return buildFrozenExperimentInput(plan, plan.items[0]!);
}

describe("feedback A/B experiment boundary", () => {
  it("passes the same frozen evidence object to Current and Planner", () => {
    const frozen = makeFrozenInput();
    const client = {} as ReturnType<typeof createLLMClient>;
    const current = buildCurrentGenerationInput(frozen, { draftClient: client, draftModel: "draft", reviewClient: client, reviewModel: "review" });
    const planner = buildPlannerInput(frozen);
    expect(current.evidenceBundle).toBe(frozen.evidenceBundle);
    expect(planner.evidenceBundle).toBe(frozen.evidenceBundle);
  });

  it("does not put the full EvidenceBundle in Writer input", () => {
    const frozen = makeFrozenInput();
    const brief = { mainFocus: "本次重点", present: [{ content: "允许披露", evidenceRefs: ["present-1"] }], background: [], interpretations: [], contextOnly: [], omit: [], communicationIntent: "自然", unresolved: [] };
    const writer = buildRestrictedWriterInput(frozen, brief);
    expect("evidenceBundle" in writer).toBe(false);
    expect(JSON.stringify(writer)).not.toContain("communicationContext");
    expect(JSON.stringify(writer)).toContain("允许披露");
  });

  it("excludes contextOnly and omit raw content from Writer input", () => {
    const frozen = makeFrozenInput();
    const brief = { mainFocus: "本次重点", present: [], background: [], interpretations: [], contextOnly: [{ content: "context-only 原始秘密", reason: "仅供 Planner 理解" }], omit: [{ evidenceRefs: ["context-1"], reason: "本次不传" }], communicationIntent: "自然", unresolved: ["Planner 内部冲突"] };
    const writer = buildRestrictedWriterInput(frozen, brief);
    const serialized = JSON.stringify(writer);
    expect(serialized).not.toContain(frozen.outputRequirement);
    expect(serialized).not.toContain("context-only 原始秘密");
    expect(serialized).not.toContain("omit");
    expect(serialized).not.toContain("contextOnly");
    expect(serialized).not.toContain("unresolved");
  });

  it("retries an invalid brief once instead of deleting unknown evidence refs", async () => {
    const plan = makePlan();
    const findUnique = vi.fn().mockResolvedValue(plan);
    const db = { feedbackPlan: { findUnique } } as unknown as FeedbackAbTestDb;
    const invalidBrief = JSON.stringify({ mainFocus: "本次重点", present: [{ content: "不应静默保留", evidenceRefs: ["unknown-ref"] }], background: [], interpretations: [], contextOnly: [], omit: [], communicationIntent: "自然", unresolved: [] });
    const validBrief = JSON.stringify({ mainFocus: "本次重点", present: [{ content: "允许披露", evidenceRefs: ["present-1"] }], background: [], interpretations: [], contextOnly: [], omit: [], communicationIntent: "自然", unresolved: [] });
    const plannerCreate = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: invalidBrief } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })
      .mockResolvedValueOnce({ choices: [{ message: { content: validBrief } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
    const writerCreate = vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ feedback: "Planner Writer 反馈" }) } }], usage: undefined });
    const createClient = vi.fn((role?: "feedbackDraft" | "feedbackReview" | "wecomExtraction") => ({ chat: { completions: { create: role === "feedbackDraft" ? plannerCreate : writerCreate } } }) as unknown as ReturnType<typeof createLLMClient>);
    const currentGenerator = vi.fn().mockResolvedValue({ composition: { draftFeedback: "Current 反馈" } } as Awaited<ReturnType<typeof generateFeedbackPlanComposition>>);
    const result = await runFeedbackAbTest({ planId: plan.id, planItemId: plan.items[0]!.id }, {
      db,
      currentGenerator,
      createClient,
      getModel: (role) => `${role}-model`,
      resolveProfileId: (role) => `${role}-profile`,
      randomAssignment: () => ({ left: "current", right: "planner_writer" }),
    });
    expect(plannerCreate).toHaveBeenCalledTimes(2);
    expect(result.plannerBrief.present[0]?.evidenceRefs).toEqual(["present-1"]);
    expect(result.tokenUsage.planner.totalTokens).toBe(6);
  });

  it("runs with a database surface that only exposes reads", async () => {
    const plan = makePlan();
    const findUnique = vi.fn().mockResolvedValue(plan);
    const db = { feedbackPlan: { findUnique } } as unknown as FeedbackAbTestDb;
    const currentGenerator = vi.fn(async (input: Parameters<typeof generateFeedbackPlanComposition>[0]) => {
      await input.draftClient.chat.completions.create({ model: "current-model", messages: [{ role: "user", content: "current call 1" }] });
      await input.draftClient.chat.completions.create({ model: "current-model", messages: [{ role: "user", content: "current call 2" }] });
      return { composition: { draftFeedback: "Current 反馈" } } as Awaited<ReturnType<typeof generateFeedbackPlanComposition>>;
    });
    const plannerResponse = JSON.stringify({ mainFocus: "本次重点", present: [{ content: "允许披露", evidenceRefs: ["present-1"] }], background: [], interpretations: [], contextOnly: [{ content: "不应进入 Writer", reason: "理解冲突" }], omit: [{ evidenceRefs: ["context-1"], reason: "不传" }], communicationIntent: "自然", unresolved: [] });
    const writerResponse = JSON.stringify({ feedback: "Planner Writer 反馈" });
    const createClient = vi.fn((role?: "feedbackDraft" | "feedbackReview" | "wecomExtraction") => ({ chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: role === "feedbackDraft" ? plannerResponse : writerResponse } }], usage: { prompt_tokens: 3, completion_tokens: 2, reasoning_tokens: 1, total_tokens: 5 } }) } } }) as unknown as ReturnType<typeof createLLMClient>);
    const result = await runFeedbackAbTest({ planId: plan.id, planItemId: plan.items[0]!.id }, {
      db,
      currentGenerator,
      createClient,
      getModel: (role) => `${role}-model`,
      resolveProfileId: (role) => `${role}-profile`,
      randomAssignment: () => ({ left: "current", right: "planner_writer" }),
    });
    expect(result.outputs.current).toBe("Current 反馈");
    expect(result.outputs.plannerWriter).toBe("Planner Writer 反馈");
    expect(result.tokenUsage.current?.totalTokens).toBe(10);
    expect(Object.keys((db as unknown as { feedbackPlan: Record<string, unknown> }).feedbackPlan)).toEqual(["findUnique"]);
  });

  it("keeps blind labels free of approach identity", () => {
    expect(BLIND_SIDE_LABELS).toEqual({ A: "方案 A", B: "方案 B" });
    expect(Object.values(BLIND_SIDE_LABELS).join(" ")).not.toMatch(/Current|Planner|Writer/);
    const result = { assignment: { left: "planner_writer", right: "current" }, outputs: { current: "current text", plannerWriter: "planner text" } } as FeedbackAbTestResult;
    expect(outputForBlindSide(result, "A")).toBe("planner text");
  });

  it("renders unavailable token usage as 不可用", () => {
    expect(formatTokenValue(null)).toBe("不可用");
    expect(formatTokenValue(undefined)).toBe("不可用");
    expect(formatTokenValue(128)).toBe("128");
  });
});
