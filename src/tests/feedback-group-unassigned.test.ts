import { describe, expect, it } from "vitest";
import {
  dismissFeedbackGroupUnassignedSource,
  dismissFeedbackGroupUnassignedSourcesForSelectedClasses,
  scopeFeedbackGroupUnassignedSources,
} from "@/features/feedback/feedback-group-unassigned";
import type { FeedbackGroupIntakeUnassigned } from "@/features/feedback/feedback-task-types";

describe("feedback group unassigned material scope", () => {
  it("does not let material attributed only to an excluded class block the selected class", () => {
    const source: FeedbackGroupIntakeUnassigned = {
      fileName: "二班同名学生.pdf",
      kind: "assessment_pdf",
      reason: "PDF 姓名在班级组内重名，无法自动归属",
      candidateStudentIds: ["student-b-1", "student-b-2"],
      candidateClassIds: ["class-b"],
    };
    const sources = [source];

    expect(scopeFeedbackGroupUnassignedSources({
      sources,
      selectedClassIds: ["class-a"],
      persistedActionableCount: 1,
    })).toEqual({ actionableSources: [], actionableCount: 0 });

    expect(scopeFeedbackGroupUnassignedSources({
      sources,
      selectedClassIds: ["class-b"],
      persistedActionableCount: 1,
    })).toEqual({ actionableSources: [source], actionableCount: 1 });
    expect(sources).toEqual([source]);
  });

  it("keeps cross-class and unattributed material actionable in the current round", () => {
    const classBOnly: FeedbackGroupIntakeUnassigned = {
      fileName: "二班候选.pdf",
      kind: "assessment_pdf",
      reason: "仅有二班候选",
      candidateClassIds: ["class-b"],
    };
    const crossClass: FeedbackGroupIntakeUnassigned = {
      fileName: "跨班重名.pdf",
      kind: "assessment_pdf",
      reason: "一班、二班都有候选",
      candidateClassIds: ["class-a", "class-b"],
    };
    const unattributed: FeedbackGroupIntakeUnassigned = {
      fileName: "无法识别.pdf",
      kind: "assessment_pdf",
      reason: "没有班级候选",
    };

    expect(scopeFeedbackGroupUnassignedSources({
      sources: [classBOnly, crossClass, unattributed],
      selectedClassIds: ["class-a"],
      persistedActionableCount: 4,
    })).toEqual({
      actionableSources: [crossClass, unattributed],
      actionableCount: 3,
    });
  });

  it("never revives sources the server already marked as non-blocking", () => {
    const skipped: FeedbackGroupIntakeUnassigned = {
      fileName: "二班课堂.step-classroom.txt",
      kind: "step_classroom",
      reason: "二班未纳入本轮处理，已跳过",
      blocking: false,
      candidateClassIds: ["class-b"],
    };

    expect(scopeFeedbackGroupUnassignedSources({
      sources: [skipped],
      selectedClassIds: ["class-b"],
      persistedActionableCount: 0,
    })).toEqual({ actionableSources: [], actionableCount: 0 });
  });

  it("dismisses selected-class material without deleting excluded-class material", () => {
    const classA: FeedbackGroupIntakeUnassigned = {
      fileName: "一班候选.pdf",
      kind: "assessment_pdf",
      reason: "仅有一班候选",
      candidateClassIds: ["class-a"],
    };
    const classB: FeedbackGroupIntakeUnassigned = {
      fileName: "二班候选.pdf",
      kind: "assessment_pdf",
      reason: "仅有二班候选",
      candidateClassIds: ["class-b"],
    };

    const dismissed = dismissFeedbackGroupUnassignedSourcesForSelectedClasses({
      sources: [classA, classB],
      selectedClassIds: ["class-a"],
    });
    expect(dismissed).toEqual({
      sources: [classB],
      persistedActionableCount: 1,
    });
    expect(scopeFeedbackGroupUnassignedSources({
      sources: dismissed.sources,
      selectedClassIds: ["class-a"],
      persistedActionableCount: dismissed.persistedActionableCount,
    }).actionableCount).toBe(0);
    expect(scopeFeedbackGroupUnassignedSources({
      sources: dismissed.sources,
      selectedClassIds: ["class-b"],
      persistedActionableCount: dismissed.persistedActionableCount,
    }).actionableCount).toBe(1);
  });

  it("dismisses only the selected unresolved file and preserves unknown blockers", () => {
    const selected: FeedbackGroupIntakeUnassigned = {
      fileName: "无法识别.pdf",
      kind: "assessment_pdf",
      reason: "题集报告中未找到总题数或正确率",
    };
    const remaining: FeedbackGroupIntakeUnassigned = {
      fileName: "另一份.pdf",
      kind: "assessment_pdf",
      reason: "PDF 未能唯一匹配当前班级学生",
    };

    expect(dismissFeedbackGroupUnassignedSource({
      sources: [selected, remaining],
      persistedActionableCount: 3,
      fileName: selected.fileName,
      kind: selected.kind,
    })).toEqual({
      sources: [remaining],
      persistedActionableCount: 2,
    });
  });

  it("does not dismiss a same-name source of a different kind", () => {
    const pdf: FeedbackGroupIntakeUnassigned = {
      fileName: "同名材料",
      kind: "assessment_pdf",
      reason: "PDF 异常",
    };
    const step: FeedbackGroupIntakeUnassigned = {
      fileName: "同名材料",
      kind: "step_classroom",
      reason: "STEP 异常",
    };

    expect(dismissFeedbackGroupUnassignedSource({
      sources: [pdf, step],
      persistedActionableCount: 2,
      fileName: pdf.fileName,
      kind: pdf.kind,
    })).toEqual({
      sources: [step],
      persistedActionableCount: 1,
    });
  });
});
