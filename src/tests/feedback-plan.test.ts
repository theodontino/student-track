import { describe, expect, it } from "vitest";
import {
  CommunicationPreferenceSchema,
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  FeedbackPlanAssessmentEvidenceSchema,
  sanitizeFeedbackComposition,
  sanitizeFeedbackEvidenceBundle,
  validateCompositionForBundle,
} from "@/lib/feedback-plan";
import { stripFeedbackInternalBoundary } from "@/lib/feedback-text-safety";
import { createAuditSnapshot } from "@/services/feedback-plan-audit";
import {
  communicationPreferenceFromSignals,
  inferCommunicationPreferenceCandidate,
  inferGroundedCommunicationPreferenceSignals,
} from "@/lib/communication-preference";

function bundle(overrides: Record<string, unknown> = {}) {
  return FeedbackEvidenceBundleSchema.parse({
    version: 1,
    planType: "event_micro",
    studentId: "student-test-1",
    teachingEvidence: [{
      id: "event-1",
      kind: "fact",
      content: "第二道同类题能够独立完成",
      sourceRefs: [{ type: "event", id: "event-test-1" }],
      confirmed: true,
    }],
    communicationContext: [],
    executionConstraints: {
      existingTaskIds: [],
      fixedArrangementRefs: [],
      teacherInterventionPresent: false,
    },
    sourceRefs: [{ type: "student", id: "student-test-1" }],
    sourceFingerprint: "test-fingerprint-123456",
    ...overrides,
  });
}

function composition(overrides: Record<string, unknown> = {}) {
  return FeedbackCompositionPlanSchema.parse({
    version: 1,
    closureType: "positive_recognition",
    needParentAction: false,
    parentAction: null,
    modules: [{
      key: "observed_moment",
      content: "第二道同类题能够独立完成",
      evidenceRefs: ["event-1"],
      status: "included",
      reason: "本次具体表现",
    }, {
      key: "teacher_interpretation",
      content: "处理过程比较稳",
      evidenceRefs: ["event-1"],
      status: "included",
      reason: "教师判断",
    }],
    evidenceCoverage: [{ evidenceId: "event-1", statement: "第二道同类题已经能够独立完成" }],
    draftFeedback: "今天第二道同类题已经能够独立完成，这个处理过程比较稳。",
    ...overrides,
  });
}

describe("feedback plan composition gate", () => {
  it("keeps old evidence snapshots compatible and accepts multiple assessment sources", () => {
    expect(bundle().assessmentEvidence).toEqual([]);
    const evidence = {
      sessionCode: "SESSION-1",
      studentId: "student-test-1",
      reportTitle: "本次结果",
      reportDate: "2099-01-01",
      totalQuestions: 2,
      correctRate: 50,
      cohortAverageRate: null,
      knowledgePoints: [],
      wrongItems: [],
      similarPracticeCount: 0,
    };
    expect(FeedbackPlanAssessmentEvidenceSchema.parse({
      "student-test-1": [
        { ...evidence, sourceType: "assessment_pdf" },
        { ...evidence, sourceType: "classroom_practice" },
      ],
    })["student-test-1"]).toHaveLength(2);
  });

  it("warns when a plan silently omits confirmed teaching or assessment evidence", () => {
    const evidence = bundle({
      teachingEvidence: [
        ...bundle().teachingEvidence,
        { id: "score-a", kind: "fact", content: "本次学习测验4分", sourceRefs: [{ type: "metric", id: "metric-1" }], confirmed: true },
      ],
      assessmentEvidence: [{
        id: "assessment-1",
        kind: "fact",
        content: "本次出门测共2题，正确1题",
        sourceRefs: [{ type: "assessment-pdf", id: "assessment-source-1" }],
        confirmed: true,
      }],
    });
    const result = validateCompositionForBundle(composition(), evidence);
    expect(result.status).toBe("needs_review");
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "final_evidence_omitted",
      severity: "requires_teacher",
      message: expect.stringContaining("score-a"),
    }));
    expect(result.issues.find((issue) => issue.code === "final_evidence_omitted")?.message).toContain("assessment-1");

    const fullyCovered = validateCompositionForBundle(composition({
      modules: [
        { key: "observed_moment", content: "课堂表现与学习测验", evidenceRefs: ["event-1", "score-a"], status: "included", reason: "课堂证据" },
        { key: "teacher_interpretation", content: "解释本次出门测", evidenceRefs: ["assessment-1"], status: "included", reason: "测评证据" },
      ],
      evidenceCoverage: [
        { evidenceId: "event-1", statement: "第二道同类题能够独立完成" },
        { evidenceId: "score-a", statement: "本次学习测验反映出基础步骤比较稳定" },
        { evidenceId: "assessment-1", statement: "本次出门测反映出部分内容还没有消化" },
      ],
      draftFeedback: "第二道同类题能够独立完成。本次学习测验反映出基础步骤比较稳定，但本次出门测反映出部分内容还没有消化。",
    }), evidence);
    expect(fullyCovered.status).toBe("pass");
  });

  it("warns when evidence IDs are attached to modules but not reflected in the final text", () => {
    const evidence = bundle({
      teachingEvidence: [
        ...bundle().teachingEvidence,
        { id: "score-a", kind: "fact", content: "本次学习测验 4 分", sourceRefs: [{ type: "metric", id: "metric-1" }], confirmed: true },
      ],
    });
    const refOnly = validateCompositionForBundle(composition({
      modules: [
        { key: "observed_moment", content: "课堂表现", evidenceRefs: ["event-1", "score-a"], status: "included", reason: "课堂证据" },
        { key: "teacher_interpretation", content: "状态稳定", evidenceRefs: ["event-1"], status: "included", reason: "教师判断" },
      ],
      evidenceCoverage: [{ evidenceId: "event-1", statement: "第二道同类题已经能够独立完成" }],
      draftFeedback: "今天第二道同类题已经能够独立完成，这个处理过程比较稳。",
    }), evidence);
    expect(refOnly.status).toBe("needs_review");
    expect(refOnly.issues).toContainEqual(expect.objectContaining({
      code: "final_evidence_omitted",
      severity: "requires_teacher",
      message: expect.stringContaining("score-a"),
    }));

    const unrelatedSentence = validateCompositionForBundle(composition({
      modules: [
        { key: "observed_moment", content: "课堂表现", evidenceRefs: ["event-1", "score-a"], status: "included", reason: "课堂证据" },
        { key: "teacher_interpretation", content: "状态稳定", evidenceRefs: ["event-1"], status: "included", reason: "教师判断" },
      ],
      evidenceCoverage: [
        { evidenceId: "event-1", statement: "第二道同类题已经能够独立完成" },
        { evidenceId: "score-a", statement: "这个处理过程比较稳" },
      ],
      draftFeedback: "今天第二道同类题已经能够独立完成，这个处理过程比较稳。",
    }), evidence);
    expect(unrelatedSentence.status).toBe("needs_review");
    expect(unrelatedSentence.issues).toContainEqual(expect.objectContaining({ code: "evidence_coverage_unsubstantiated" }));
  });

  it("allows a teacher-reviewed final text to omit draft evidence while recording the omission", () => {
    const result = validateCompositionForBundle(composition({
      evidenceCoverage: [],
      draftFeedback: "教师最终选择只保留简短结论。",
    }), bundle());
    expect(result.status).toBe("needs_review");
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "final_evidence_omitted",
      severity: "requires_teacher",
    }));
    expect(result.issues.some((issue) => issue.severity === "blocked")).toBe(false);
  });

  it("allows a positive recognition without a parent action or future promise", () => {
    const result = validateCompositionForBundle(composition(), bundle());
    expect(result.status).toBe("pass");
    expect(result.issues).toEqual([]);
  });

  it("keeps internal boundary notes out of evidence and draft text", () => {
    const boundary = "证据边界：只能解释本次结果，不据此推断长期能力或人格特征";
    expect(stripFeedbackInternalBoundary(`本次结果如下。${boundary}`)).toBe("本次结果如下。");
    expect(sanitizeFeedbackEvidenceBundle(bundle({
      teachingEvidence: [{
        ...bundle().teachingEvidence[0],
        content: `本次表现稳定。${boundary}`,
      }],
    })).teachingEvidence[0]?.content).toBe("本次表现稳定。");
    expect(sanitizeFeedbackComposition(composition({ draftFeedback: `本次表现稳定。${boundary}` })).draftFeedback).toBe("本次表现稳定。");
  });

  it("warns about student-directed language only while auditing model-generated parent text", () => {
    const studentDirected = composition({ draftFeedback: "你今天第二道同类题已经能够独立完成，继续加油。" });
    const generatedAudit = validateCompositionForBundle(
      studentDirected,
      bundle(),
      undefined,
      undefined,
      { enforceParentAudience: true },
    );
    expect(generatedAudit.status).toBe("needs_review");
    expect(generatedAudit.issues).toContainEqual(expect.objectContaining({ code: "recipient_mismatch" }));

    const teacherEditAudit = validateCompositionForBundle(studentDirected, bundle());
    expect(teacherEditAudit.issues.some((issue) => issue.code === "recipient_mismatch")).toBe(false);
  });

  it("warns about a parent action hidden in text when the action switch is false", () => {
    const result = validateCompositionForBundle(composition({ draftFeedback: "麻烦家长提醒孩子今晚完成订正。" }), bundle());
    expect(result.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "implicit_parent_action")).toBe(true);

    const indirect = validateCompositionForBundle(composition({ draftFeedback: "希望家长关注孩子的作息。" }), bundle());
    expect(indirect.status).toBe("needs_review");
    expect(indirect.issues.some((issue) => issue.code === "implicit_parent_action")).toBe(true);
  });

  it("warns about an enabled parent-action module without structured action content", () => {
    const result = validateCompositionForBundle(composition({
      modules: [
        ...composition().modules,
        { key: "parent_action", content: "关注作息", evidenceRefs: ["event-1"], status: "included", reason: "模型建议" },
      ],
    }), bundle());
    expect(result.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "parent_action_content_missing")).toBe(true);
  });

  it("does not mistake classroom actions or chemistry model terms for parent actions/internal content", () => {
    const classroomReminder = validateCompositionForBundle(composition({
      draftFeedback: "第二道同类题已经能够独立完成；我在课堂上提醒学生先圈出题目条件。",
    }), bundle());
    expect(classroomReminder.status).toBe("pass");
    expect(classroomReminder.issues).toEqual([]);

    const chemistryModel = validateCompositionForBundle(composition({
      draftFeedback: "第二道同类题已经能够独立完成；今天使用分子模型后，结构判断更清楚了。",
    }), bundle());
    expect(chemistryModel.status).toBe("pass");
    expect(chemistryModel.issues).toEqual([]);
  });

  it("warns about follow-up observation without an approved task", () => {
    const result = validateCompositionForBundle(composition({
      closureType: "continued_observation",
      modules: [{
        key: "followup_observation",
        content: "下次课再看是否稳定",
        evidenceRefs: ["event-1"],
        status: "included",
        reason: "需要后续观察",
      }, {
        key: "teacher_interpretation",
        content: "当前方法正在形成",
        evidenceRefs: ["event-1"],
        status: "included",
        reason: "判断",
      }],
      draftFeedback: "第二道同类题已经能够独立完成；我会在下次课继续观察这部分是否稳定。",
    }), bundle());
    expect(result.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "followup_without_task")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "promise_without_task")).toBe(true);
  });

  it("warns about a teacher's future action even when it is phrased as a neutral plan", () => {
    const result = validateCompositionForBundle(composition({
      draftFeedback: "老师会在下次课检查这部分是否稳定。",
    }), bundle());
    expect(result.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "promise_without_task")).toBe(true);
  });

  it("requires teacher confirmation for an existing-task promise", () => {
    const result = validateCompositionForBundle(composition({
      closureType: "continued_observation",
      modules: [{
        key: "followup_observation",
        content: "下次课再看是否稳定",
        evidenceRefs: ["event-1"],
        status: "included",
        reason: "需要后续观察",
      }, {
        key: "teacher_interpretation",
        content: "当前方法正在形成",
        evidenceRefs: ["event-1"],
        status: "included",
        reason: "判断",
      }],
      draftFeedback: "第二道同类题已经能够独立完成；我会在下次课继续观察这部分是否稳定。",
    }), bundle({ executionConstraints: { existingTaskIds: ["task-test-1"], fixedArrangementRefs: [], teacherInterventionPresent: false } }), new Set(["task-test-1"]));
    expect(result.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "promise_requires_teacher")).toBe(true);
  });

  it("sends teacher intervention modules without confirmed evidence to teacher review", () => {
    const result = validateCompositionForBundle(composition({
      closureType: "teacher_resolved",
      modules: [{
        key: "teacher_intervention",
        content: "课堂上补做了一道同类题",
        evidenceRefs: ["event-1"],
        status: "included",
        reason: "课堂处理",
      }],
      draftFeedback: "我在课堂上补做了一道同类题，第二次已经能够完成。",
    }), bundle());
    expect(result.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "teacher_intervention_unconfirmed")).toBe(true);
  });

  it("keeps communication preferences explicit and unknown-safe", () => {
    expect(CommunicationPreferenceSchema.parse({
      version: 1,
      length: "unknown",
      evidence: "classroom_example",
      terminology: "plain",
      familyParticipation: "inform_only",
      frequency: "stage_only",
    })).toMatchObject({ length: "unknown", familyParticipation: "inform_only" });
  });

  it("produces a hash that changes when the final teacher text changes", () => {
    const first = createAuditSnapshot(composition(), bundle());
    const second = createAuditSnapshot(composition({ draftFeedback: "今天第二道同类题已经能够独立完成。" }), bundle());
    expect(first.textHash).not.toBe(second.textHash);
  });

  it("extracts explicit communication signals as a pending-safe candidate", () => {
    const result = inferCommunicationPreferenceCandidate("家长希望反馈简短一些，保留课堂例子；家庭只需要提醒完成订正，不需要额外讲解。");
    expect(result?.preference).toMatchObject({ length: "short", evidence: "classroom_example", familyParticipation: "remind_confirm" });
    expect(result?.signals.length).toBeGreaterThan(0);
  });

  it("does not treat an ordinary observation as a family communication preference", () => {
    expect(inferCommunicationPreferenceCandidate("家长说我观察到孩子今天上课很专注。"))
      .toBeNull();
  });

  it("grounds only direct incoming feedback preference wording", () => {
    expect(inferGroundedCommunicationPreferenceSignals([{
      id: "message-1",
      direction: "incoming",
      content: "文字和语音都可以，简短反馈即可。",
    }])).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "length", value: "short", messageId: "message-1" }),
      expect.objectContaining({ field: "deliveryChannel", value: "either", messageId: "message-1" }),
    ]));
    expect(inferGroundedCommunicationPreferenceSignals([{
      id: "message-2",
      direction: "outgoing",
      content: "文字和语音都可以吗？",
    }])).toEqual([]);
    expect(inferGroundedCommunicationPreferenceSignals([{
      id: "message-3",
      direction: "incoming",
      content: "简短或详细都可以，文字和语音均可。",
    }])).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "length" }),
    ]));
  });

  it("grounds a flexible reply from the immediately preceding teacher question", () => {
    const signals = inferGroundedCommunicationPreferenceSignals([
      {
        id: "question",
        direction: "outgoing",
        content: "能接受微信电话吗？反馈要详细还是简短？倾向语音还是文字？",
      },
      {
        id: "answer",
        direction: "incoming",
        content: "我都可以，看老师方便。",
      },
    ]);
    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "length", value: "flexible", messageId: "answer" }),
      expect.objectContaining({ field: "deliveryChannel", value: "either", messageId: "answer" }),
      expect.objectContaining({ field: "phoneContact", value: "accepted", messageId: "answer" }),
    ]));
    expect(communicationPreferenceFromSignals(signals)?.preference).toMatchObject({
      length: "flexible",
      deliveryChannel: "either",
      phoneContact: "accepted",
    });
  });

  it("does not infer an answer from acknowledgement or an unrelated reply", () => {
    const question = {
      id: "question",
      direction: "outgoing",
      content: "能接受微信电话吗？反馈要详细还是简短？倾向语音还是文字？",
    };
    for (const content of ["收到，老师辛苦了！", "这个作业孩子不是很明白"]) {
      expect(inferGroundedCommunicationPreferenceSignals([
        question,
        { id: "answer", direction: "incoming", content },
      ])).toEqual([]);
    }
  });
});
