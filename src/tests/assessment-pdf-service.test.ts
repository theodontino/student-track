import { describe, expect, it } from "vitest";
import { parseAssessmentPdfText } from "@/services/assessment-pdf-service";

const syntheticReport = `题集报告
PROBLEM SET REPORT 2099/07/13

04示例基础
张三 TEST20260001

HI～亲爱的张三同学～
你合计完成了5道小题，正确率为80%，高于平均正确率72.2%。

知识点分析
示例概念辨析 共4小题 正确率100.0% 均值82.3%
示例分类判断 共1小题 正确率0.0% 均值31.7%

作答明细
 1
示例题目
    我的答案
 D
    正确答案
 A
    解析
 示例解析
    知识图谱
 示例分类判断

专属
学员：张三 教师：王老师 生成时间：2099-07-13

张三的化学错题相似题
 1 单选题
示例相似题
`;

describe("assessment PDF parser", () => {
  it("extracts identity, summary, weak knowledge points and wrong answers", () => {
    const parsed = parseAssessmentPdfText(syntheticReport, "04示例报告（张三）.pdf");
    expect(parsed.reportStudentName).toBe("张三");
    expect(parsed.evidence).toMatchObject({
      reportTitle: "04示例基础",
      reportDate: "2099-07-13",
      totalQuestions: 5,
      correctRate: 80,
      cohortAverageRate: 72.2,
      similarPracticeCount: 1,
    });
    expect(parsed.evidence.knowledgePoints).toHaveLength(2);
    expect(parsed.evidence.wrongItems).toEqual([{
      questionNumber: "1",
      studentAnswer: "D",
      correctAnswer: "A",
      knowledgePoints: ["示例分类判断"],
    }]);
  });

  it("rejects image-only or unrelated text", () => {
    expect(() => parseAssessmentPdfText("只有图片，没有题集文字", "scan.pdf"))
      .toThrow("未识别到受支持的题集报告文字");
  });
});
