import { describe, expect, it, vi } from "vitest";
import { parseLessonFeedbackMaterial } from "@/lib/feedback-materials";
import {
  composeFeedbackPromptContext,
  generateRoutineFeedback,
  generateReviewedFeedback,
  reviewFeedbackDraft,
} from "@/services/feedback-generation-service";

function clientWith(...contents: string[]) {
  const create = vi.fn();
  for (const content of contents) {
    create.mockResolvedValueOnce({ choices: [{ message: { content } }] });
  }
  return { client: { chat: { completions: { create } } } as any, create };
}

describe("feedback generation review", () => {
  it("uses one short final pass for routine feedback without inventing advice", async () => {
    const routine = clientWith(JSON.stringify({
      verdict: "pass",
      feedback: "今天课堂跟得比较稳，电离方程式的基础书写完成得顺利。",
      issues: [],
    }));
    const result = await generateRoutineFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成电离方程式基础书写。",
      client: routine.client,
      model: "routine-model",
    });
    expect(result).toMatchObject({
      feedback: "今天课堂跟得比较稳，电离方程式的基础书写完成得顺利。",
      reviewStatus: "passed",
      draftFeedback: "",
    });
    expect(routine.create).toHaveBeenCalledTimes(1);
    expect(routine.create.mock.calls[0][0].messages[0].content).toContain("默认只描述");
    expect(routine.create.mock.calls[0][0]).toMatchObject({ max_tokens: 768, reasoning_effort: "none" });
  });
  it("keeps class copy separate from individual student evidence", () => {
    const context = composeFeedbackPromptContext({
      studentContext: "学生甲，本次个人记录：测验4分。",
      lessonMaterial: parseLessonFeedbackMaterial(
        "【课堂内容】\n电解质分类\n【课堂重点】\n概念判断",
        "主要考察以下内容：\n1. 电解质概念\n孩子这次存在一定错误。",
      ),
    });
    expect(context).toContain("课程公共材料");
    expect(context).toContain("不得据此断言该生掌握或失误");
    expect(context).not.toContain("存在一定错误");
  });

  it("turns an internal analysis into a separately reviewed parent message", async () => {
    const draft = clientWith("本次主动订正错题；近期记录显示学习投入较稳定，可建议继续复盘。 ");
    const review = clientWith(JSON.stringify({ verdict: "pass", feedback: "今天孩子能够主动订正错题，近期学习投入也比较稳定。建议继续保持课后复盘的习惯，把订正过程中的思路及时整理下来。", issues: [] }));

    const result = await generateReviewedFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课主动订正错题。",
      lengthRequirement: "90-140字",
      draftClient: draft.client,
      draftModel: "draft-model",
      reviewClient: review.client,
      reviewModel: "review-model",
    });

    expect(result).toMatchObject({
      draftFeedback: "本次主动订正错题；近期记录显示学习投入较稳定，可建议继续复盘。",
      feedback: "今天孩子能够主动订正错题，近期学习投入也比较稳定。建议继续保持课后复盘的习惯，把订正过程中的思路及时整理下来。",
      reviewStatus: "passed",
      reviewIssues: [],
    });
    expect(draft.create).toHaveBeenCalledWith(expect.objectContaining({ model: "draft-model", temperature: 0.5 }));
    expect(review.create).toHaveBeenCalledWith(expect.objectContaining({ model: "review-model", temperature: 0 }));
    expect(draft.create.mock.calls[0][0].messages[0].content).toContain("内部分析草稿");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("内部分析只是辅助材料");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("三种真实感受");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("只突出一个核心结论");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("只有明确的前后证据");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("不得将全学期常态对照改写");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("普通情况可直接结束");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("整体表现优异");
  });

  it("uses a supported revision and retains the original draft", async () => {
    const result = await reviewFeedbackDraft({
      studentName: "学生甲",
      promptContext: "学生甲本节课主动订正错题。",
      lengthRequirement: "90-140字",
      draftFeedback: "学生甲成绩已经大幅提升。",
      client: clientWith(JSON.stringify({
        verdict: "revise",
        feedback: "本节课能够主动订正错题，建议继续保持认真复盘的习惯。",
        issues: ["原稿包含背景未支持的成绩结论"],
      })).client,
      model: "review-model",
    });

    expect(result).toMatchObject({
      draftFeedback: "学生甲成绩已经大幅提升。",
      feedback: "本节课能够主动订正错题，建议继续保持认真复盘的习惯。",
      reviewStatus: "revised",
      reviewIssues: ["原稿包含背景未支持的成绩结论"],
    });
  });

  it("requires manual review after malformed reviewer output", async () => {
    const review = clientWith("not-json", "still-not-json");
    const result = await reviewFeedbackDraft({
      studentName: "学生甲",
      promptContext: "本节课无明确表现记录。",
      lengthRequirement: "90-140字",
      draftFeedback: "今天表现很好。",
      client: review.client,
      model: "review-model",
    });

    expect(result.reviewStatus).toBe("needs_review");
    expect(result.feedback).toBe("");
    expect(result.draftFeedback).toBe("今天表现很好。");
    expect(result.reviewIssues[0]).toContain("连续两次");
    expect(review.create).toHaveBeenCalledTimes(2);
  });

  it("does not approve text mentioning another student", async () => {
    const review = clientWith(JSON.stringify({ verdict: "pass", feedback: "学生甲比学生乙完成得更好。", issues: [] }));
    const result = await reviewFeedbackDraft({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成练习。",
      forbiddenStudentNames: ["学生乙"],
      lengthRequirement: "90-140字",
      draftFeedback: "学生甲比学生乙完成得更好。",
      client: review.client,
      model: "review-model",
    });

    expect(result.reviewStatus).toBe("needs_review");
    expect(result.reviewIssues).toContain("反馈中出现了其他学生姓名");
    expect(result.feedback).toBe("");
  });
});
