import { describe, expect, it, vi } from "vitest";
import { lessonMaterialPrompt, parseLessonFeedbackMaterial } from "@/lib/feedback-materials";
import {
  composeFeedbackPromptContext,
  generateFeedbackDraft,
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
    expect(routine.create.mock.calls[0][0].messages[0].content).toContain("90—140字");
    expect(routine.create.mock.calls[0][0].messages[0].content).toContain("孩子被看见");
    expect(routine.create.mock.calls[0][0].messages[0].content).toContain("不得用空泛夸奖代替事实");
    expect(routine.create.mock.calls[0][0]).toMatchObject({ max_tokens: 2048 });
    expect(routine.create.mock.calls[0][0]).not.toHaveProperty("reasoning_effort");
  });

  it("retries a truncated routine response with a larger token budget", async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ choices: [{ finish_reason: "length", message: { content: "" } }] })
      .mockResolvedValueOnce({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        verdict: "pass",
        feedback: "今天能够结合课堂步骤完成基础判断，关键概念的对应关系比较清楚。",
        issues: [],
      }) } }] });
    const result = await generateRoutineFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成基础判断。",
      client: { chat: { completions: { create } } } as any,
      model: "routine-model",
    });

    expect(result).toMatchObject({ reviewStatus: "passed", reviewIssues: [] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 2048 });
    expect(create.mock.calls[1][0]).toMatchObject({ max_tokens: 4096 });
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
    expect(context).toContain("不得据此断言该生掌握或失误");
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
      outputStrategy: { flaggedIssue: true, trendChange: false, backgroundBaseline: false, strategySuggestion: false, suggestedFeedback: true },
    });
    expect(context).toContain("本次有一道概念题需要留意");
    expect(context).not.toContain("续班风险警告");
    expect(context).not.toContain("旧上下文");
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
    expect(draft.create.mock.calls[0][0]).toMatchObject({
      max_tokens: 2048,
      reasoning_effort: "none",
    });
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("内部分析只是辅助材料");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("三种真实感受");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("只突出一个核心结论");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("只有明确的前后证据");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("不得将全学期常态对照改写");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("普通情况可直接结束");
    expect(review.create.mock.calls[0][0].messages[0].content).toContain("整体表现优异");
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
      lengthRequirement: "90-140字",
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
    expect(review.create.mock.calls[1][0]).toMatchObject({ reasoning_effort: "none" });
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

  it("blocks recipient placeholders in routine parent-facing output", async () => {
    const routine = clientWith(JSON.stringify({
      verdict: "pass",
      feedback: "XX妈妈您好，孩子今天完成了基础概念判断。",
      issues: [],
    }));
    const result = await generateRoutineFeedback({
      studentName: "学生甲",
      promptContext: "学生甲本节课完成基础概念判断。",
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
      lengthRequirement: "90-140字",
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
});
