import { describe, expect, it } from "vitest";
import {
  CommunicationPreferenceSchema,
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  validateCompositionForBundle,
} from "@/lib/feedback-plan";
import { createAuditSnapshot } from "@/services/feedback-plan-audit";
import {
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
    draftFeedback: "今天第二道同类题已经能够独立完成，这个处理过程比较稳。",
    ...overrides,
  });
}

describe("feedback plan composition gate", () => {
  it("allows a positive recognition without a parent action or future promise", () => {
    const result = validateCompositionForBundle(composition(), bundle());
    expect(result.status).toBe("pass");
    expect(result.issues).toEqual([]);
  });

  it("blocks a parent action hidden in text when the action switch is false", () => {
    const result = validateCompositionForBundle(composition({ draftFeedback: "麻烦家长提醒孩子今晚完成订正。" }), bundle());
    expect(result.status).toBe("blocked");
    expect(result.issues.some((issue) => issue.code === "implicit_parent_action")).toBe(true);

    const indirect = validateCompositionForBundle(composition({ draftFeedback: "希望家长关注孩子的作息。" }), bundle());
    expect(indirect.status).toBe("blocked");
    expect(indirect.issues.some((issue) => issue.code === "implicit_parent_action")).toBe(true);
  });

  it("blocks an enabled parent-action module without structured action content", () => {
    const result = validateCompositionForBundle(composition({
      modules: [
        ...composition().modules,
        { key: "parent_action", content: "关注作息", evidenceRefs: ["event-1"], status: "included", reason: "模型建议" },
      ],
    }), bundle());
    expect(result.status).toBe("blocked");
    expect(result.issues.some((issue) => issue.code === "parent_action_content_missing")).toBe(true);
  });

  it("does not mistake classroom actions or chemistry model terms for parent actions/internal content", () => {
    const classroomReminder = validateCompositionForBundle(composition({
      draftFeedback: "我在课堂上提醒学生先圈出题目条件，第二题已经完成。",
    }), bundle());
    expect(classroomReminder.status).toBe("pass");
    expect(classroomReminder.issues).toEqual([]);

    const chemistryModel = validateCompositionForBundle(composition({
      draftFeedback: "今天使用分子模型后，结构判断更清楚了。",
    }), bundle());
    expect(chemistryModel.status).toBe("pass");
    expect(chemistryModel.issues).toEqual([]);
  });

  it("blocks follow-up observation without an approved task", () => {
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
      draftFeedback: "我会在下次课继续观察这部分是否稳定。",
    }), bundle());
    expect(result.status).toBe("blocked");
    expect(result.issues.some((issue) => issue.code === "followup_without_task")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "promise_without_task")).toBe(true);
  });

  it("blocks a teacher's future action even when it is phrased as a neutral plan", () => {
    const result = validateCompositionForBundle(composition({
      draftFeedback: "老师会在下次课检查这部分是否稳定。",
    }), bundle());
    expect(result.status).toBe("blocked");
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
      draftFeedback: "我会在下次课继续观察这部分是否稳定。",
    }), bundle({ executionConstraints: { existingTaskIds: ["task-test-1"], fixedArrangementRefs: [], teacherInterventionPresent: false } }), new Set(["task-test-1"]));
    expect(result.status).toBe("needs_review");
    expect(result.issues.some((issue) => issue.code === "promise_requires_teacher")).toBe(true);
  });

  it("does not allow teacher intervention modules without confirmed evidence", () => {
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
    expect(result.status).toBe("blocked");
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
});
