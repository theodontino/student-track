import { describe, expect, it } from "vitest";
import {
  assessmentEvidencePrompt,
  lessonMaterialPrompt,
  parseLessonFeedbackMaterial,
  planAssessmentFolderImport,
  type StudentAssessmentEvidence,
} from "@/lib/feedback-materials";

describe("feedback materials", () => {
  it("extracts reusable class material without retaining template student judgments", () => {
    const material = parseLessonFeedbackMaterial(
      `🤗各位家长好
高一化学 暑期第4讲群反馈《电解质与电离方程式》
🎁【课堂内容】
1、电解质相关概念及物质分类
2、电离方程式
⭐【课堂重点】
1、电解质与非电解质的判断
⏰【课堂说明】
通过实验和分类示例帮助学生理解概念。
✍【课后作业】
1、整理笔记`,
      `这次出门测主要考察了以下内容：
1. 对电解质概念以及常见易错点的考查；
2. 电离方程式的书写。
孩子这次出门测存在一定错误。
孩子可以结合讲解视频进行订正，有不会的问题及时答疑。`,
    );

    expect(material.lessonTitle).toBe("电解质与电离方程式");
    expect(material.classroomContent).toEqual([
      "电解质相关概念及物质分类",
      "电离方程式",
    ]);
    expect(material.classroomFocus).toEqual(["电解质与非电解质的判断"]);
    expect(material.homework).toEqual(["整理笔记"]);
    expect(material.assessmentFocus).toHaveLength(2);
    expect(material.correctionAdvice.join("；")).toContain("订正");
    const prompt = lessonMaterialPrompt(material);
    expect(prompt).not.toContain("存在一定错误");
    expect(prompt).toContain("不能证明该学生已经掌握");
    expect(prompt).toContain("通过实验和分类示例");
    expect(prompt).toContain("整理笔记");
    expect(prompt).toContain("出门测考查范围");
    expect(prompt).toContain("电离方程式的书写");
  });

  it("formats only distilled assessment evidence for the model", () => {
    const evidence: StudentAssessmentEvidence = {
      reportTitle: "04电解质基础",
      reportDate: "2099-07-13",
      totalQuestions: 5,
      correctRate: 80,
      cohortAverageRate: 72.2,
      knowledgePoints: [{
        name: "电解质与非电解质的判断",
        questionCount: 1,
        correctRate: 0,
        cohortAverageRate: 31.7,
      }],
      wrongItems: [{
        questionNumber: "5",
        studentAnswer: "D",
        correctAnswer: "A",
        knowledgePoints: ["电解质与非电解质的判断"],
      }],
      similarPracticeCount: 1,
    };

    const prompt = assessmentEvidencePrompt(evidence);
    expect(prompt).toContain("正确率80%");
    expect(prompt).toContain("第5题本人答D、正确答案A");
    expect(prompt).toContain("先不看答案重做第5题");
    expect(prompt).toContain("再完成报告附带的1道相似练习");
    expect(prompt).toContain("每题写一句判断依据");
    expect(prompt).toContain("不得据此推断长期能力");
  });

  it("removes a generic student judgment while preserving advice on the same line", () => {
    const material = parseLessonFeedbackMaterial(
      "",
      "孩子这次出门测存在一定错误，孩子可以结合讲解视频进行订正，有不会的问题及时答疑。",
      "SESSION-1",
    );

    expect(material.correctionAdvice).toEqual([
      "孩子可以结合讲解视频进行订正，有不会的问题及时答疑。",
    ]);
    expect(lessonMaterialPrompt(material)).not.toContain("存在一定错误");
  });

  it("removes recipient placeholders from reusable public material", () => {
    const material = parseLessonFeedbackMaterial(
      "XX妈妈您好，今天群内统一反馈如下\n张三妈妈您好\n【课堂内容】\n离子反应基础",
      "某某家长您好，请查收出门测说明。\n主要考察以下内容：\n1. 离子方程式",
      "SESSION-1",
    );

    expect([
      ...material.classroomContent,
      ...material.classroomFocus,
      ...material.classroomExplanation,
      ...material.homework,
      ...material.assessmentFocus,
      ...material.correctionAdvice,
      ...material.otherNotes,
    ].join("；")).not.toMatch(/XX妈妈|某某家长|张三妈妈/);
    expect(material.groupFeedbackRaw).toContain("XX妈妈");
    expect(lessonMaterialPrompt(material)).not.toMatch(/XX妈妈|某某家长/);
  });

  it("pre-matches one report folder against only the selected session roster", () => {
    const plan = planAssessmentFolderImport([
      { name: "04电解质基础报告（张三）.pdf", webkitRelativePath: "第4讲报告/04电解质基础报告（张三）.pdf" },
      { name: "04电解质基础报告（李四）.pdf", webkitRelativePath: "第4讲报告/04电解质基础报告（李四）.pdf" },
      { name: "04电解质基础报告（其他班王五）.pdf", webkitRelativePath: "第4讲报告/04电解质基础报告（其他班王五）.pdf" },
      { name: "说明.txt", webkitRelativePath: "第4讲报告/说明.txt" },
    ], [
      { id: "student-1", name: "张三", studentId: "S001" },
      { id: "student-2", name: "李四", studentId: "S002" },
      { id: "student-3", name: "赵六", studentId: "S003" },
    ]);

    expect(plan.folderName).toBe("第4讲报告");
    expect(plan.totalPdfCount).toBe(3);
    expect(plan.matched).toEqual([
      expect.objectContaining({ fileName: expect.stringContaining("张三"), studentId: "student-1" }),
      expect.objectContaining({ fileName: expect.stringContaining("李四"), studentId: "student-2" }),
    ]);
    expect(plan.missingStudents).toEqual([{ id: "student-3", name: "赵六" }]);
    expect(plan.ignoredFileCount).toBe(1);
  });

  it("keeps only the first report when a folder contains duplicates for one student", () => {
    const plan = planAssessmentFolderImport([
      { name: "报告（张三）.pdf" },
      { name: "报告补发（张三）.pdf" },
    ], [{ id: "student-1", name: "张三" }]);

    expect(plan.matched).toHaveLength(1);
    expect(plan.duplicateStudents).toEqual(["张三"]);
    expect(plan.ignoredFileCount).toBe(1);
  });
});
