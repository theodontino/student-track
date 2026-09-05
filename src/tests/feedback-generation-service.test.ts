import { describe, expect, it, vi } from "vitest";
import { generateFreeFeedbackPlanComposition } from "@/services/feedback-generation-service";

function clientWith(...contents: string[]) {
  const create = vi.fn();
  for (const content of contents) {
    create.mockResolvedValueOnce({ choices: [{ message: { content } }] });
  }
  return { client: { chat: { completions: { create } } } as any, create };
}

describe("free feedback generation", () => {
  it("normalizes exact evidence and model dates at the generation boundary", async () => {
    const composition = {
      version: 1,
      closureType: "positive_recognition",
      needParentAction: false,
      parentAction: null,
      modules: [
        { key: "observed_moment", content: "2026-07-20 完成了同类题", evidenceRefs: ["event-1"], status: "included", reason: "课堂事实" },
        { key: "teacher_interpretation", content: "2026-07-20 的方法较稳", evidenceRefs: ["event-1"], status: "included", reason: "教师判断" },
      ],
      evidenceCoverage: [{ evidenceId: "event-1", statement: "2026-07-20 完成了同类题" }],
      draftFeedback: "2026-07-20 完成了同类题，方法较稳。",
    };
    const draft = clientWith(JSON.stringify(composition));
    const result = await generateFreeFeedbackPlanComposition({
      studentName: "合成学生",
      planType: "event_micro",
      outputRequirement: "自然表达",
      evidenceBundle: {
        version: 1,
        planType: "event_micro",
        studentId: "student-1",
        teachingEvidence: [{ id: "event-1", kind: "fact", content: "2026-07-20 完成了同类题", sourceRefs: [{ type: "event", id: "source-1" }], confirmed: true }],
        assessmentEvidence: [],
        communicationContext: [],
        executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
        sourceRefs: [{ type: "student", id: "student-1" }],
        sourceFingerprint: "feedback-plan-relative-date-fingerprint",
      },
      style: "gentle",
      length: "standard",
      draftClient: draft.client,
      draftModel: "draft-model",
      referenceDate: "2026-07-21",
      generationPreferences: { closureType: "positive_recognition", moduleKeys: ["observed_moment", "teacher_interpretation"] },
    });

    expect(result.composition.draftFeedback).toBe("昨天 完成了同类题，方法较稳。");
    expect(result.composition.draftFeedback).not.toContain("2026-07-20");
    expect(result.audit.status).toBe("pass");
  });

  it("keeps hard checks with one free composition call", async () => {
    const composition = {
      version: 1,
      closureType: "positive_recognition",
      needParentAction: false,
      parentAction: null,
      modules: [
        { key: "observed_moment", content: "课堂完成了基础题", evidenceRefs: ["event-1"], status: "included", reason: "课堂事实" },
        { key: "teacher_interpretation", content: "方法正在稳定", evidenceRefs: ["event-1"], status: "included", reason: "教师判断" },
      ],
      evidenceCoverage: [{ evidenceId: "event-1", statement: "课堂完成了基础题" }],
      draftFeedback: "课堂完成了基础题，方法正在稳定。",
    };
    const draft = clientWith(JSON.stringify(composition));

    const result = await generateFreeFeedbackPlanComposition({
      studentName: "合成学生",
      planType: "event_micro",
      outputRequirement: "自然表达。",
      evidenceBundle: {
        version: 1,
        planType: "event_micro",
        studentId: "student-1",
        teachingEvidence: [{ id: "event-1", kind: "fact", content: "课堂完成了基础题", sourceRefs: [{ type: "event", id: "source-1" }], confirmed: true }],
        assessmentEvidence: [],
        communicationContext: [],
        executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
        sourceRefs: [{ type: "student", id: "student-1" }],
        sourceFingerprint: "feedback-plan-fast-mode-fingerprint",
      },
      style: "gentle",
      length: "standard",
      draftClient: draft.client,
      draftModel: "draft-model",
    });

    expect(result.composition.draftFeedback).toBe("课堂完成了基础题，方法正在稳定。");
    expect(result.audit.status).toBe("pass");
    expect(draft.create).toHaveBeenCalledTimes(1);
  });

  it("keeps incomplete evidence coverage as a soft teacher-review reminder", async () => {
    const incomplete = {
      version: 1,
      closureType: "positive_recognition",
      needParentAction: false,
      parentAction: null,
      modules: [
        { key: "observed_moment", content: "课堂完成了基础题", evidenceRefs: ["event-1"], status: "included", reason: "课堂事实" },
        { key: "teacher_interpretation", content: "本次课堂参与稳定", evidenceRefs: ["event-1"], status: "included", reason: "课堂解读" },
      ],
      evidenceCoverage: [{ evidenceId: "event-1", statement: "本次课堂完成了基础题" }],
      draftFeedback: "本次课堂完成了基础题，参与状态稳定。",
    };
    const draft = clientWith(JSON.stringify(incomplete));

    const result = await generateFreeFeedbackPlanComposition({
      studentName: "合成学生",
      planType: "event_micro",
      outputRequirement: "自然表达，可以基于事实充分分析，但不要改写具体事实。",
      evidenceBundle: {
        version: 1,
        planType: "event_micro",
        studentId: "student-1",
        teachingEvidence: [
          { id: "event-1", kind: "fact", content: "课堂完成了基础题", sourceRefs: [{ type: "event", id: "source-1" }], confirmed: true },
          { id: "score-b", kind: "fact", content: "本次课堂状态4分", sourceRefs: [{ type: "metric", id: "metric-1" }], confirmed: true },
        ],
        assessmentEvidence: [{ id: "assessment-1", kind: "fact", content: "出门测正确率50%，第二题错误", sourceRefs: [{ type: "assessment-pdf", id: "assessment-source-1" }], confirmed: true }],
        communicationContext: [],
        executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
        sourceRefs: [{ type: "student", id: "student-1" }],
        sourceFingerprint: "feedback-plan-all-evidence-fingerprint",
      },
      style: "gentle",
      length: "standard",
      draftClient: draft.client,
      draftModel: "draft-model",
    });

    expect(result.audit.status).toBe("needs_review");
    expect(result.audit.items).toContainEqual(expect.objectContaining({
      code: "final_evidence_omitted",
      severity: "requires_teacher",
    }));
    expect(result.composition.draftFeedback).toContain("参与状态稳定");
    expect(draft.create.mock.calls[0][0].messages[0].content).toContain("教师自然语言反馈要求与补充事实（最高优先级）");
    expect(draft.create.mock.calls[0][0].messages[0].content).toContain("自然表达,可以基于事实充分分析,但不要改写具体事实。");
    expect(draft.create.mock.calls[0][0].messages[0].content).toContain("内部结构化默认值只在教师自然语言没有说明时生效");
    expect(draft.create.mock.calls[0][0].messages[0].content).toContain("教师输入中的事实陈述视为教师已确认事实");
    expect(draft.create.mock.calls[0][0].messages[0].content).toContain("充分联想");
  });

  it("keeps an incomplete model draft reviewable instead of dropping the student item", async () => {
    const incomplete = {
      version: 1,
      closureType: "positive_recognition",
      needParentAction: false,
      parentAction: null,
      modules: [
        { key: "observed_moment", content: "课堂完成了基础题", evidenceRefs: ["event-1"], status: "included", reason: "课堂事实" },
        { key: "teacher_interpretation", content: "本次课堂参与稳定", evidenceRefs: ["event-1"], status: "included", reason: "课堂解读" },
      ],
      evidenceCoverage: [{ evidenceId: "event-1", statement: "课堂完成了基础题" }],
      draftFeedback: "课堂完成了基础题，参与状态比较稳定。",
    };
    const draft = clientWith(JSON.stringify(incomplete));

    const result = await generateFreeFeedbackPlanComposition({
      studentName: "合成学生",
      planType: "event_micro",
      outputRequirement: "自然表达，可以基于事实充分分析，但不要改写具体事实。",
      evidenceBundle: {
        version: 1,
        planType: "event_micro",
        studentId: "student-1",
        teachingEvidence: [
          { id: "event-1", kind: "fact", content: "课堂完成了基础题", sourceRefs: [{ type: "event", id: "source-1" }], confirmed: true },
          { id: "score-1", kind: "fact", content: "本次课堂状态较稳定", sourceRefs: [{ type: "metric", id: "metric-1" }], confirmed: true },
        ],
        assessmentEvidence: [],
        communicationContext: [],
        executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
        sourceRefs: [{ type: "student", id: "student-1" }],
        sourceFingerprint: "feedback-plan-incomplete-draft-fingerprint",
      },
      style: "gentle",
      length: "standard",
      draftClient: draft.client,
      draftModel: "draft-model",
    });

    expect(result.composition.draftFeedback).toContain("课堂完成了基础题");
    expect(result.audit.status).toBe("needs_review");
    expect(result.audit.items).toContainEqual(expect.objectContaining({
      code: "final_evidence_omitted",
      severity: "requires_teacher",
    }));
  });

  it("keeps invalid legacy module keys visible to deterministic review", async () => {
    const legacy = {
      version: 1,
      closureType: "informational",
      needParentAction: false,
      parentAction: null,
      modules: [
        { key: "current_performance", content: "本次完成稳定", evidenceRefs: ["legacy-current"], status: "included", reason: "旧模块" },
        { key: "trend_summary", content: "阶段表现稳定", evidenceRefs: ["legacy-trend"], status: "included", reason: "旧模块" },
      ],
      draftFeedback: "本阶段学习表现比较稳定。",
    };
    const draft = clientWith(JSON.stringify(legacy));

    const result = await generateFreeFeedbackPlanComposition({
      studentName: "合成学生",
      planType: "course_end",
      outputRequirement: "自然表达，可以基于事实充分分析，但不要改写具体事实。",
      evidenceBundle: {
        version: 1,
        planType: "course_end",
        studentId: "student-1",
        teachingEvidence: [
          { id: "event-1", kind: "fact", content: "阶段开始时完成基础题", sourceRefs: [{ type: "event", id: "source-1" }], confirmed: true },
          { id: "event-2", kind: "fact", content: "本次已能独立完成", sourceRefs: [{ type: "event", id: "source-2" }], confirmed: true },
        ],
        assessmentEvidence: [],
        communicationContext: [],
        executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
        sourceRefs: [{ type: "student", id: "student-1" }],
        sourceFingerprint: "feedback-plan-test-fingerprint",
      },
      style: "gentle",
      length: "short",
      draftClient: draft.client,
      draftModel: "draft-model",
    });

    expect(result.audit.status).toBe("needs_review");
    expect(result.composition.closureType).toBe("informational");
    expect(result.composition.modules.map((module) => module.key)).toEqual(["current_performance", "trend_summary"]);
    expect(draft.create.mock.calls[0][0]).toMatchObject({
      response_format: { type: "json_object" },
    });
    expect(draft.create.mock.calls[0][0]).not.toHaveProperty("temperature");
  });

  it("repairs an incomplete structured draft with the same free executor", async () => {
    const incomplete = JSON.stringify({
      version: 1,
      needParentAction: false,
      parentAction: null,
      modules: [],
      draftFeedback: "本次已经能够独立完成。",
    });
    const repaired = {
      version: 1,
      closureType: "positive_recognition",
      needParentAction: false,
      parentAction: null,
      modules: [
        { key: "starting_state", content: "阶段开始时完成基础题", evidenceRefs: ["event-1"], status: "included", reason: "起点" },
        { key: "evidence_backed_change", content: "本次已能独立完成", evidenceRefs: ["event-2"], status: "included", reason: "变化" },
      ],
      evidenceCoverage: [
        { evidenceId: "event-1", statement: "阶段开始时能够完成基础题" },
        { evidenceId: "event-2", statement: "这次已经能独立完成同类任务" },
      ],
      draftFeedback: "阶段开始时能够完成基础题，这次已经能独立完成同类任务。",
    };
    const draft = clientWith(incomplete, JSON.stringify(repaired));

    const result = await generateFreeFeedbackPlanComposition({
      studentName: "合成学生",
      planType: "course_end",
      outputRequirement: "自然表达，可以基于事实充分分析，但不要改写具体事实。",
      evidenceBundle: {
        version: 1,
        planType: "course_end",
        studentId: "student-1",
        teachingEvidence: [
          { id: "event-1", kind: "fact", content: "阶段开始时完成基础题", sourceRefs: [{ type: "event", id: "source-1" }], confirmed: true },
          { id: "event-2", kind: "fact", content: "本次已能独立完成", sourceRefs: [{ type: "event", id: "source-2" }], confirmed: true },
        ],
        assessmentEvidence: [],
        communicationContext: [],
        executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
        sourceRefs: [{ type: "student", id: "student-1" }],
        sourceFingerprint: "feedback-plan-repair-fingerprint",
      },
      style: "gentle",
      length: "short",
      draftClient: draft.client,
      draftModel: "draft-model",
    });

    expect(result.audit.status).toBe("pass");
    expect(draft.create).toHaveBeenCalledTimes(2);
    expect(draft.create.mock.calls[1][0]).toMatchObject({ reasoning_effort: "none" });
  });

  it("normalizes an omitted parentAction when the model explicitly says no action is needed", async () => {
    const compositionWithoutNullableField = {
      version: 1,
      closureType: "positive_recognition",
      needParentAction: false,
      modules: [
        { key: "starting_state", content: "阶段开始时完成基础题", evidenceRefs: ["event-1"], status: "included", reason: "起点" },
        { key: "evidence_backed_change", content: "本次已能独立完成", evidenceRefs: ["event-2"], status: "included", reason: "变化" },
      ],
      evidenceCoverage: [
        { evidenceId: "event-1", statement: "阶段开始时能够完成基础题" },
        { evidenceId: "event-2", statement: "这次已经能独立完成同类任务" },
      ],
      draftFeedback: "阶段开始时能够完成基础题，这次已经能独立完成同类任务。",
    };
    const draft = clientWith(JSON.stringify(compositionWithoutNullableField));

    const result = await generateFreeFeedbackPlanComposition({
      studentName: "合成学生",
      planType: "course_end",
      outputRequirement: "自然表达，可以基于事实充分分析，但不要改写具体事实。",
      evidenceBundle: {
        version: 1,
        planType: "course_end",
        studentId: "student-1",
        teachingEvidence: [
          { id: "event-1", kind: "fact", content: "阶段开始时完成基础题", sourceRefs: [{ type: "event", id: "source-1" }], confirmed: true },
          { id: "event-2", kind: "fact", content: "本次已能独立完成", sourceRefs: [{ type: "event", id: "source-2" }], confirmed: true },
        ],
        assessmentEvidence: [],
        communicationContext: [],
        executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
        sourceRefs: [{ type: "student", id: "student-1" }],
        sourceFingerprint: "feedback-plan-normalize-fingerprint",
      },
      style: "gentle",
      length: "short",
      draftClient: draft.client,
      draftModel: "draft-model",
    });

    expect(result.audit.status).toBe("pass");
    expect(result.composition).toMatchObject({ needParentAction: false, parentAction: null });
  });

  it("uses only one free composition request", async () => {
    const composition = {
      version: 1,
      closureType: "positive_recognition",
      needParentAction: false,
      parentAction: null,
      modules: [
        { key: "starting_state", content: "阶段开始时完成基础题", evidenceRefs: ["event-1"], status: "included", reason: "起点" },
        { key: "evidence_backed_change", content: "本次已能独立完成", evidenceRefs: ["event-2"], status: "included", reason: "变化" },
      ],
      evidenceCoverage: [
        { evidenceId: "event-1", statement: "阶段开始时能够完成基础题" },
        { evidenceId: "event-2", statement: "这次已经能独立完成同类任务" },
      ],
      draftFeedback: "阶段开始时能够完成基础题，这次已经能独立完成同类任务。",
    };
    const draft = clientWith(JSON.stringify(composition));

    const result = await generateFreeFeedbackPlanComposition({
      studentName: "合成学生",
      planType: "course_end",
      outputRequirement: "自然表达，可以基于事实充分分析，但不要改写具体事实。",
      evidenceBundle: {
        version: 1,
        planType: "course_end",
        studentId: "student-1",
        teachingEvidence: [
          { id: "event-1", kind: "fact", content: "阶段开始时完成基础题", sourceRefs: [{ type: "event", id: "source-1" }], confirmed: true },
          { id: "event-2", kind: "fact", content: "本次已能独立完成", sourceRefs: [{ type: "event", id: "source-2" }], confirmed: true },
        ],
        assessmentEvidence: [],
        communicationContext: [],
        executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
        sourceRefs: [{ type: "student", id: "student-1" }],
        sourceFingerprint: "feedback-plan-review-repair-fingerprint",
      },
      style: "gentle",
      length: "short",
      draftClient: draft.client,
      draftModel: "draft-model",
    });

    expect(result.audit.status).toBe("pass");
    expect(draft.create).toHaveBeenCalledTimes(1);
  });
});
