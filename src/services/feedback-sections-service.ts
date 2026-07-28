import type { StudentAssessmentEvidence } from "@/lib/feedback-materials";
import type { FeedbackSections } from "@/lib/feedback-sections";
import type { FeedbackRoutingDecision } from "@/lib/feedback-intensity";
import type { FeedbackContextResult, FeedbackContextStudent } from "@/services/feedback-context-service";
import { FEEDBACK_ROUTING_REASON_LABELS } from "@/lib/feedback-intensity";

function currentFact(student: FeedbackContextStudent): FeedbackSections["currentFact"] {
  const values = student.rawMetrics.current;
  const scoreText = [
    `学习测验 ${values.scoreA ?? "未录"}分`,
    `课堂状态 ${values.scoreB ?? "未录"}分`,
    `课后任务 ${values.scoreC ?? "未录"}分`,
  ];
  if (values.events.length > 0) scoreText.push(`课堂记录：${values.events.slice(0, 2).join("；")}`);
  return {
    content: scoreText.join("；"),
    evidence: [{ source: "current-session", label: "本次已确认评价与课堂记录" }],
  };
}

function issueSection(student: FeedbackContextStudent, evidence?: StudentAssessmentEvidence): FeedbackSections["flaggedIssue"] {
  const current = student.rawMetrics.current;
  if (evidence && evidence.correctRate < 60) {
    const cohort = evidence.cohortAverageRate === null ? "" : `，班级参考正确率 ${evidence.cohortAverageRate}%`;
    return {
      content: `本次出门测正确率 ${evidence.correctRate}%${cohort}，需要先核对错题涉及的知识点。`,
      evidence: [{ source: "assessment", label: "已确认出门测报告" }],
    };
  }
  if (current.scoreA !== null && current.scoreA <= 2) {
    return {
      content: `本次学习测验为 ${current.scoreA} 分，当前课堂理解或当堂完成需要继续留意。`,
      evidence: [{ source: "current-session", label: "本次学习测验评价" }],
    };
  }
  if (current.scoreB !== null && current.scoreB <= 2) {
    return {
      content: `本次课堂状态为 ${current.scoreB} 分，课堂投入或纪律表现需要继续留意。`,
      evidence: [{ source: "current-session", label: "本次课堂状态评价" }],
    };
  }
  if (current.scoreC !== null && current.scoreC <= 2) {
    return {
      content: `本次课后任务为 ${current.scoreC} 分，课后落实情况需要继续留意。`,
      evidence: [{ source: "current-session", label: "本次课后任务评价" }],
    };
  }
  return undefined;
}

function trendSection(student: FeedbackContextStudent): FeedbackSections["trendChange"] {
  const baseline = student.rawMetrics.performanceBaseline;
  if (baseline.recentValidCount < 2 || baseline.semesterValidCount < 3 || baseline.personalDifference === null) return undefined;
  const difference = baseline.personalDifference;
  if (Math.abs(difference) < 0.5) return undefined;
  const direction = difference > 0 ? "高于" : "低于";
  return {
    content: `最近两次学习测验平均 ${baseline.recentAverageA?.toFixed(1)} 分，${direction}本学期个人平均 ${Math.abs(difference).toFixed(1)} 分。`,
    evidence: [{ source: "history", label: "本学期已确认学习测验记录" }],
  };
}

function baselineSection(student: FeedbackContextStudent): FeedbackSections["backgroundBaseline"] {
  const baseline = student.rawMetrics.performanceBaseline;
  if (baseline.semesterValidCount < 3 || baseline.semesterAverageA === null) return undefined;
  const classComparison = baseline.classAverageDifference === null
    ? "同期班级数据不足，未做班级对照"
    : `最近可比课次平均${baseline.classAverageDifference >= 0 ? "高" : "低"}${Math.abs(baseline.classAverageDifference).toFixed(1)}分`;
  return {
    content: `本学期已有 ${baseline.semesterValidCount} 次有效学习测验，个人平均 ${baseline.semesterAverageA.toFixed(1)} 分；${classComparison}。`,
    evidence: [{ source: "history", label: "本学期有效评价基线" }],
  };
}

function strategySection(issue: FeedbackSections["flaggedIssue"], routing: FeedbackRoutingDecision): FeedbackSections["strategySuggestion"] {
  if (!issue && routing.intensity === "routine") return undefined;
  if (issue?.content.includes("出门测")) {
    return { content: "下次课先复核本次错题涉及的核心判断，再决定是否需要额外课后安排。", evidence: issue.evidence };
  }
  if (routing.intensity === "priority") {
    return { content: "下次课优先做一次简短的当堂确认，核对本次问题是否持续出现。", evidence: [{ source: "teaching-summary", label: "当前学习风险与教学观察" }] };
  }
  if (issue) {
    return { content: "下次课继续观察这一项表现，确认它是一次波动还是需要持续跟进的问题。", evidence: issue.evidence };
  }
  return { content: "保持常规课堂观察即可，暂不额外安排家庭任务。", evidence: [{ source: "current-session", label: "本次课堂事实" }] };
}

/**
 * Produces deterministic, teacher-facing modules. Renewal signals never enter
 * the parent-facing prompt; they are only rendered in the internal panel.
 */
export function buildFeedbackSections(
  context: FeedbackContextResult,
  routing: FeedbackRoutingDecision[],
  assessmentEvidence: Record<string, StudentAssessmentEvidence>,
): Map<string, FeedbackSections> {
  const routingByStudent = new Map(routing.map((item) => [item.studentId, item]));

  return new Map(context.students.map((student) => {
    const decision = routingByStudent.get(student.id) ?? { studentId: student.id, baseline: "routine" as const, intensity: "routine" as const, reasons: [] };
    const flaggedIssue = issueSection(student, assessmentEvidence[student.id]);
    const trendChange = trendSection(student);
    const backgroundBaseline = baselineSection(student);
    const strategySuggestion = strategySection(flaggedIssue, decision);
    const renewalPieces = decision.reasons.map((reason) => FEEDBACK_ROUTING_REASON_LABELS[reason]);
    const sections: FeedbackSections = {
      currentFact: currentFact(student),
      ...(flaggedIssue ? { flaggedIssue } : {}),
      ...(trendChange ? { trendChange } : {}),
      ...(backgroundBaseline ? { backgroundBaseline } : {}),
      ...(renewalPieces.length > 0 ? {
        renewalAlert: {
          content: renewalPieces.join("；"),
          evidence: [{ source: "teaching-summary", label: "Dashboard 风险与未关闭教学观察" }],
        },
      } : {}),
      ...(strategySuggestion ? { strategySuggestion } : {}),
    };
    return [student.id, sections];
  }));
}
