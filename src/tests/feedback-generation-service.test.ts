import { describe, expect, it, vi } from "vitest";
import { lessonMaterialPrompt, parseLessonFeedbackMaterial } from "@/lib/feedback-materials";
import {
  FEEDBACK_LENGTHS,
  FEEDBACK_STYLES,
  visibleFeedbackLength,
} from "@/lib/feedback-sections";
import {
  composeFeedbackPromptContext,
  generateFeedbackDraft,
  generateFeedbackPlanComposition,
  generateRoutineFeedback,
  generateReviewedFeedback,
  reviewFeedbackDraft,
  summarizeLessonMaterial,
} from "@/services/feedback-generation-service";

function clientWith(...contents: string[]) {
  const create = vi.fn();
  for (const content of contents) {
    create.mockResolvedValueOnce({ choices: [{ message: { content } }] });
  }
  return { client: { chat: { completions: { create } } } as any, create };
}

describe("feedback generation review", () => {
  it("keeps hard checks but skips the LLM review and polish call in fast mode", async () => {
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
    const review = clientWith(JSON.stringify({ ...composition, draftFeedback: "不应调用的审核结果" }));

    const result = await generateFeedbackPlanComposition({
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
      reviewClient: review.client,
      reviewModel: "review-model",
      generationMode: "fast",
    });

    expect(result.composition.draftFeedback).toBe("课堂完成了基础题，方法正在稳定。");
    expect(result.audit.status).toBe("pass");
    expect(draft.create).toHaveBeenCalledTimes(1);
    expect(review.create).not.toHaveBeenCalled();
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
    const review = clientWith(JSON.stringify(incomplete));

    const result = await generateFeedbackPlanComposition({
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
      reviewClient: review.client,
      reviewModel: "review-model",
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
    expect(review.create).toHaveBeenCalledTimes(1);
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
    const review = clientWith(JSON.stringify(incomplete));

    const result = await generateFeedbackPlanComposition({
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
      reviewClient: review.client,
      reviewModel: "review-model",
    });

    expect(result.composition.draftFeedback).toContain("课堂完成了基础题");
    expect(result.audit.status).toBe("needs_review");
    expect(result.audit.items).toContainEqual(expect.objectContaining({
      code: "final_evidence_omitted",
      severity: "requires_teacher",
    }));
  });

  it("repairs legacy module keys before a course-end plan is saved", async () => {
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
    const corrected = {
      ...legacy,
      closureType: "positive_recognition",
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
    const draft = clientWith(JSON.stringify(legacy));
    const review = clientWith(JSON.stringify(corrected), JSON.stringify(corrected));

    const result = await generateFeedbackPlanComposition({
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
      reviewClient: review.client,
      reviewModel: "review-model",
    });

    expect(result.audit.status).toBe("pass");
    expect(result.composition.closureType).toBe("positive_recognition");
    expect(result.composition.modules.map((module) => module.key)).toEqual(["starting_state", "evidence_backed_change"]);
    expect(review.create).toHaveBeenCalledTimes(2);
    expect(draft.create.mock.calls[0][0]).toMatchObject({
      response_format: { type: "json_object" },
    });
    expect(draft.create.mock.calls[0][0]).not.toHaveProperty("temperature");
  });

  it("repairs an incomplete structured draft before review", async () => {
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
    const draft = clientWith(incomplete);
    const review = clientWith(JSON.stringify(repaired), JSON.stringify(repaired));

    const result = await generateFeedbackPlanComposition({
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
      reviewClient: review.client,
      reviewModel: "review-model",
    });

    expect(result.audit.status).toBe("pass");
    expect(review.create).toHaveBeenCalledTimes(2);
    expect(review.create.mock.calls[0][0]).toMatchObject({ reasoning_effort: "none" });
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
    const review = clientWith(JSON.stringify(compositionWithoutNullableField));

    const result = await generateFeedbackPlanComposition({
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
      reviewClient: review.client,
      reviewModel: "review-model",
    });

    expect(result.audit.status).toBe("pass");
    expect(result.composition).toMatchObject({ needParentAction: false, parentAction: null });
    expect(review.create).toHaveBeenCalledTimes(1);
  });

  it("repairs malformed review JSON with reasoning disabled", async () => {
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
    const review = clientWith("{\"version\":1,", JSON.stringify({ ...composition, evidenceCoverage: "broken" }));

    const result = await generateFeedbackPlanComposition({
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
      reviewClient: review.client,
      reviewModel: "review-model",
    });

    expect(result.audit.status).toBe("pass");
    expect(review.create).toHaveBeenCalledTimes(2);
    expect(review.create.mock.calls[1][0]).toMatchObject({ reasoning_effort: "none" });
  });

  it("uses one structured completion for routine feedback", async () => {
    const routine = clientWith(JSON.stringify({
      verdict: "pass",
      feedback: "今天课堂跟得比较稳，电离方程式的基础书写完成得顺利，能够按照条件逐步核对符号和配平；遇到不确定的地方也愿意停下来检查，这种处理方式比较扎实。",
      issues: [],
    }));
    const result = await generateRoutineFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成电离方程式基础书写。",
      style: "balanced",
      length: "short",
      client: routine.client,
      model: "routine-model",
    });
    expect(result).toMatchObject({
      feedback: "今天课堂跟得比较稳，电离方程式的基础书写完成得顺利，能够按照条件逐步核对符号和配平；遇到不确定的地方也愿意停下来检查，这种处理方式比较扎实。",
      reviewStatus: "passed",
      draftFeedback: "",
    });
    expect(routine.create).toHaveBeenCalledTimes(1);
    expect(routine.create.mock.calls[0][0]).toMatchObject({ max_tokens: 2048 });
    expect(routine.create.mock.calls[0][0]).not.toHaveProperty("reasoning_effort");
  });

  it("retries a truncated routine response with a larger token budget", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ finish_reason: "length", message: { content: "" } }] })
      .mockResolvedValueOnce({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        verdict: "pass",
        feedback: "今天能够结合课堂步骤完成基础判断，关键概念的对应关系比较清楚；遇到不确定的条件时也能回到题目逐项核对，并根据提示完成修正，处理过程比较稳。",
        issues: [],
      }) } }] });
    const result = await generateRoutineFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成基础判断。",
      style: "balanced",
      length: "short",
      client: { chat: { completions: { create } } } as any,
      model: "routine-model",
    });

    expect(result).toMatchObject({ reviewStatus: "passed", reviewIssues: [] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 2048 });
    expect(create.mock.calls[1][0]).toMatchObject({ max_tokens: 4096 });
  });

  it("accepts every persisted style and qualitative detail option", async () => {
    for (const style of FEEDBACK_STYLES) {
      for (const length of FEEDBACK_LENGTHS) {
        const feedback = length === "short" ? "本次步骤清楚。" : "本次步骤清楚，能够依据条件逐项核对并完成修正。";
        const routine = clientWith(JSON.stringify({ verdict: "pass", feedback, issues: [] }));
        const result = await generateRoutineFeedback({
          studentName: "学生甲",
          promptContext: "学生甲本节课完成了已确认的课堂任务。",
          style,
          length,
          client: routine.client,
          model: "routine-model",
        });
        expect(result.reviewStatus, `${style}/${length}`).toBe("passed");
        expect(result.feedback).toBe(feedback);
      }
    }
  });

  it("counts characters for display but never blocks a valid result by length", async () => {
    expect(visibleFeedbackLength("甲 乙\n，。")).toBe(4);
    const routine = clientWith(JSON.stringify({
      verdict: "pass",
      feedback: "本次步骤清楚。",
      issues: [],
    }));
    const result = await generateRoutineFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成了已确认的课堂任务。",
      style: "concise_objective",
      length: "short",
      client: routine.client,
      model: "routine-model",
    });
    expect(result.reviewStatus).toBe("passed");
    expect(result.reviewIssues).toEqual([]);
  });
  it("keeps class copy separate from individual student evidence", () => {
    const context = composeFeedbackPromptContext({
      studentContext: "学生甲，本次个人记录：测验4分。",
      lessonMaterial: parseLessonFeedbackMaterial(
        "【课堂内容】\n电解质分类\n【课堂重点】\n概念判断",
        "主要考察以下内容：\n1. 电解质概念\n孩子这次存在一定错误。",
      ),
    });
    expect(context).toContain("本班本课课程摘要");
    expect(context).not.toContain("存在一定错误");
  });

  it("places individual assessment evidence before the minimal public topic boundary", () => {
    const context = composeFeedbackPromptContext({
      studentContext: "学生甲，本次个人记录：测验4分。",
      lessonMaterial: parseLessonFeedbackMaterial(
        "【课堂内容】\n电解质分类\n【课堂重点】\n概念判断",
        "主要考察以下内容：\n1. 电解质概念",
      ),
      assessmentEvidence: {
        reportTitle: "个人出门测",
        reportDate: "2026-07-28",
        totalQuestions: 5,
        correctRate: 80,
        cohortAverageRate: null,
        knowledgePoints: [],
        wrongItems: [],
        similarPracticeCount: 0,
      },
    });

    expect(context.indexOf("【该生出门测客观证据】"))
      .toBeLessThan(context.indexOf("【本班本课课程摘要"));
  });

  it("selects the matching private script only when individual assessment evidence exists", () => {
    const material = {
      ...parseLessonFeedbackMaterial("【课堂内容】\n函数", "考查函数定义"),
      scriptLessonNumber: 4,
      perfectPrivateTemplate: "全对模板：本次基础扎实。",
      errorPrivateTemplate: "有误模板：第X题需要订正。",
    };
    const evidence = {
      reportTitle: "个人出门测",
      reportDate: "2026-08-02",
      totalQuestions: 5,
      correctRate: 80,
      cohortAverageRate: null,
      knowledgePoints: [],
      wrongItems: [{
        questionNumber: "2",
        studentAnswer: "A",
        correctAnswer: "B",
        knowledgePoints: ["函数定义"],
      }],
      similarPracticeCount: 0,
    };

    const errorContext = composeFeedbackPromptContext({ studentContext: "学生甲", lessonMaterial: material, assessmentEvidence: evidence });
    expect(errorContext).toContain("有误模板");
    expect(errorContext).not.toContain("全对模板");

    const perfectContext = composeFeedbackPromptContext({
      studentContext: "学生甲",
      lessonMaterial: material,
      assessmentEvidence: { ...evidence, correctRate: 100, wrongItems: [] },
    });
    expect(perfectContext).toContain("全对模板");
    expect(perfectContext).not.toContain("有误模板");

    const noEvidenceContext = composeFeedbackPromptContext({ studentContext: "学生甲", lessonMaterial: material });
    expect(noEvidenceContext).not.toContain("全对模板");
    expect(noEvidenceContext).not.toContain("有误模板");
  });

  it("builds one reusable lesson understanding from class material and an anonymized PDF structure", async () => {
    const material = parseLessonFeedbackMaterial(
      "【课堂内容】\n电解质分类\n电离方程式书写\n【课堂重点】\n强弱电解质判断",
      "主要考察以下内容：\n1. 电解质概念\n2. 电离方程式",
      "SESSION-1",
    );
    const summaryClient = clientWith(JSON.stringify({
      summary: "本课围绕电解质分类、电离方程式书写及强弱电解质判断展开，并通过五道出门测覆盖概念辨析与方程式表达。",
    }));
    const evidence = {
      "private-student-id": {
        sessionCode: "SESSION-1",
        studentId: "private-student-id",
        reportTitle: "张三的出门测报告",
        reportDate: "2026-07-28",
        totalQuestions: 5,
        correctRate: 40,
        cohortAverageRate: 80,
        knowledgePoints: [{
          name: "电离方程式",
          questionCount: 2,
          correctRate: 0,
          cohortAverageRate: 75,
        }],
        wrongItems: [{
          questionNumber: "3",
          studentAnswer: "D",
          correctAnswer: "A",
          knowledgePoints: ["电离方程式"],
        }],
        similarPracticeCount: 1,
      },
    };

    const summarized = await summarizeLessonMaterial({
      material,
      assessmentEvidence: evidence,
      client: summaryClient.client,
      model: "summary-model",
    });
    const reused = await summarizeLessonMaterial({
      material: summarized,
      assessmentEvidence: evidence,
      client: summaryClient.client,
      model: "summary-model",
    });

    expect(summaryClient.create).toHaveBeenCalledTimes(1);
    expect(reused.lessonSummaryStatus).toBe("model");
    expect(lessonMaterialPrompt(reused)).toContain("本课围绕电解质分类");
    const requestText = summaryClient.create.mock.calls[0][0].messages[0].content;
    expect(requestText).toContain("电离方程式");
    expect(requestText).toContain('"totalQuestions":5');
    expect(requestText).not.toContain("private-student-id");
    expect(requestText).not.toContain("张三");
    expect(requestText).not.toContain('"correctRate"');
    expect(requestText).not.toContain('"studentAnswer"');
    expect(requestText).not.toContain('"correctAnswer"');
  });

  it("sanitizes recipient placeholders anywhere in model context", () => {
    const context = composeFeedbackPromptContext({
      studentContext: "XX妈妈此前提到孩子做题容易着急。",
    });

    expect(context).not.toContain("XX妈妈");
    expect(context).toContain("家长此前提到");
  });

  it("never places teacher-only renewal alerts into the parent prompt", () => {
    const context = composeFeedbackPromptContext({
      studentContext: "不应进入结构化模式的旧上下文",
      sections: {
        currentFact: { content: "学习测验 4 分", evidence: [] },
        flaggedIssue: { content: "本次有一道概念题需要留意。", evidence: [] },
        renewalAlert: { content: "续班风险警告：家长仍在犹豫。", evidence: [] },
      },
      outputStrategy: { flaggedIssue: true, trendChange: false, backgroundBaseline: false, strategySuggestion: false, suggestedFeedback: true, style: "balanced", length: "standard" },
    });
    expect(context).toContain("本次有一道概念题需要留意");
    expect(context).not.toContain("续班风险警告");
    expect(context).not.toContain("旧上下文");
  });

  it("uses separate draft and review clients", async () => {
    const draft = clientWith("本次主动订正错题；近期记录显示学习投入较稳定，可建议继续复盘。 ");
    const review = clientWith(JSON.stringify({ verdict: "pass", feedback: "今天孩子能够主动订正错题，近期学习投入也比较稳定。建议继续保持课后复盘的习惯，把订正过程中的思路及时整理下来，下次遇到相近问题时再按同样步骤核对。", issues: [] }));

    const result = await generateReviewedFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课主动订正错题。",
      style: "balanced",
      length: "short",
      draftClient: draft.client,
      draftModel: "draft-model",
      reviewClient: review.client,
      reviewModel: "review-model",
    });

    expect(result).toMatchObject({
      draftFeedback: "本次主动订正错题；近期记录显示学习投入较稳定，可建议继续复盘。",
      feedback: "今天孩子能够主动订正错题，近期学习投入也比较稳定。建议继续保持课后复盘的习惯，把订正过程中的思路及时整理下来，下次遇到相近问题时再按同样步骤核对。",
      reviewStatus: "passed",
      reviewIssues: [],
    });
    expect(draft.create).toHaveBeenCalledWith(expect.objectContaining({ model: "draft-model" }));
    expect(review.create).toHaveBeenCalledWith(expect.objectContaining({ model: "review-model" }));
    expect(draft.create.mock.calls[0][0]).not.toHaveProperty("temperature");
    expect(review.create.mock.calls[0][0]).not.toHaveProperty("temperature");
    expect(draft.create.mock.calls[0][0]).toMatchObject({
      max_tokens: 2048,
      reasoning_effort: "none",
    });
  });

  it("retries a truncated analysis draft without reasoning and with a larger budget", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ finish_reason: "length", message: { content: "" } }],
      })
      .mockResolvedValueOnce({
        choices: [{ finish_reason: "stop", message: { content: "本次能够完成概念判断，错题需要继续核对条件。" } }],
      });

    const result = await generateFeedbackDraft({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成概念判断。",
      style: "balanced",
      length: "short",
      client: { chat: { completions: { create } } } as any,
      model: "draft-model",
    });

    expect(result).toBe("本次能够完成概念判断，错题需要继续核对条件。");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      max_tokens: 2048,
      reasoning_effort: "none",
    });
    expect(create.mock.calls[1][0]).toMatchObject({
      max_tokens: 4096,
      reasoning_effort: "none",
    });
  });

  it("uses a supported revision and retains the original draft", async () => {
    const result = await reviewFeedbackDraft({
      studentName: "学生甲",
      promptContext: "学生甲本节课主动订正错题。",
      style: "balanced",
      length: "short",
      draftFeedback: "学生甲成绩已经大幅提升。",
      client: clientWith(JSON.stringify({
        verdict: "revise",
        feedback: "本节课能够主动订正错题，建议继续保持认真复盘的习惯，并把修正前后的思路简要记录下来；下次遇到相近题型时可以按照同样步骤先核对条件，再完成判断。",
        issues: ["原稿包含背景未支持的成绩结论"],
      })).client,
      model: "review-model",
    });

    expect(result).toMatchObject({
      draftFeedback: "学生甲成绩已经大幅提升。",
      feedback: "本节课能够主动订正错题，建议继续保持认真复盘的习惯，并把修正前后的思路简要记录下来；下次遇到相近题型时可以按照同样步骤先核对条件，再完成判断。",
      reviewStatus: "revised",
      reviewIssues: ["原稿包含背景未支持的成绩结论"],
    });
  });

  it("requires manual review after malformed reviewer output", async () => {
    const review = clientWith("not-json", "still-not-json");
    const result = await reviewFeedbackDraft({
      studentName: "学生甲",
      promptContext: "本节课无明确表现记录。",
      style: "balanced",
      length: "short",
      draftFeedback: "今天表现很好。",
      client: review.client,
      model: "review-model",
    });

    expect(result.reviewStatus).toBe("needs_review");
    expect(result.feedback).toBe("");
    expect(result.draftFeedback).toBe("今天表现很好。");
    expect(result.reviewIssues[0]).toContain("连续两次");
    expect(review.create).toHaveBeenCalledTimes(2);
    expect(review.create.mock.calls[1][0]).toMatchObject({ reasoning_effort: "none" });
  });

  it("does not approve text mentioning another student", async () => {
    const review = clientWith(JSON.stringify({ verdict: "pass", feedback: "学生甲比学生乙完成得更好。", issues: [] }));
    const result = await reviewFeedbackDraft({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成练习。",
      forbiddenStudentNames: ["学生乙"],
      style: "balanced",
      length: "short",
      draftFeedback: "学生甲比学生乙完成得更好。",
      client: review.client,
      model: "review-model",
    });

    expect(result.reviewStatus).toBe("needs_review");
    expect(result.reviewIssues).toContain("反馈中出现了其他学生姓名");
    expect(result.feedback).toBe("");
  });

  it("blocks recipient placeholders in routine parent-facing output", async () => {
    const routine = clientWith(JSON.stringify({
      verdict: "pass",
      feedback: "XX妈妈您好，孩子今天完成了基础概念判断。",
      issues: [],
    }));
    const result = await generateRoutineFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成基础概念判断。",
      style: "balanced",
      length: "short",
      client: routine.client,
      model: "routine-model",
    });

    expect(result.reviewStatus).toBe("needs_review");
    expect(result.feedback).toBe("");
    expect(result.reviewIssues).toContain("反馈中出现了家长称呼占位符");
  });

  it("blocks recipient placeholders in reviewed parent-facing output", async () => {
    const result = await reviewFeedbackDraft({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成练习。",
      style: "balanced",
      length: "short",
      draftFeedback: "本次完成练习。",
      client: clientWith(JSON.stringify({
        verdict: "pass",
        feedback: "某某家长您好，孩子本节课完成了练习。",
        issues: [],
      })).client,
      model: "review-model",
    });

    expect(result.reviewStatus).toBe("needs_review");
    expect(result.feedback).toBe("");
    expect(result.reviewIssues).toContain("反馈中出现了家长称呼占位符");
  });

  it("blocks routine output that directly addresses the student", async () => {
    const routine = clientWith(JSON.stringify({
      verdict: "pass",
      feedback: "你今天完成了基础概念判断，继续加油。",
      issues: [],
    }));
    const result = await generateRoutineFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成基础概念判断。",
      style: "balanced",
      length: "short",
      client: routine.client,
      model: "routine-model",
    });

    expect(result.reviewStatus).toBe("needs_review");
    expect(result.feedback).toBe("");
    expect(result.reviewIssues).toContain("家长反馈错误地直接面向学生");
  });

  it("blocks reviewed output that directly addresses the student", async () => {
    const result = await reviewFeedbackDraft({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成练习。",
      style: "balanced",
      length: "short",
      draftFeedback: "本次完成练习。",
      client: clientWith(JSON.stringify({
        verdict: "pass",
        feedback: "希望你下次继续保持今天的状态。",
        issues: [],
      })).client,
      model: "review-model",
    });

    expect(result.reviewStatus).toBe("needs_review");
    expect(result.feedback).toBe("");
    expect(result.reviewIssues).toContain("家长反馈错误地直接面向学生");
  });
});
