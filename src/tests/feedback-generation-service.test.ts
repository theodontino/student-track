import { describe, expect, it, vi } from "vitest";
import {
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
