import type {
  FeedbackIntakeDecision,
  FeedbackIntakeDecisionAction,
  FeedbackIntakeIssue,
} from "@/services/feedback-intake-service";
import { isSourceScopedBoundaryIssue } from "@/lib/feedback-intake-rules";

export type MaterialIssueStage = "class" | "student" | "session" | "fact";

export type MaterialUnassignedSource = {
  fileName: string;
  kind: "assistant_roster" | "step_classroom" | "assessment_pdf" | "ignored";
};

export type MaterialIssueActionInput = {
  id?: string;
  code?: string;
  message?: string;
  runId?: string;
  sourceName?: string;
  sourceId?: string;
  stage?: MaterialIssueStage;
  scoreConflict?: FeedbackIntakeIssue["scoreConflict"];
  assessmentDuplicate?: FeedbackIntakeIssue["assessmentDuplicate"];
  attendanceConflict?: FeedbackIntakeIssue["attendanceConflict"];
  unassignedSource?: MaterialUnassignedSource;
};

type MaterialBulkChoice = {
  key: string;
  label: string;
};

export type MaterialIssueChoice = {
  action: FeedbackIntakeDecisionAction;
  label: string;
  candidateId?: string;
  sourceName?: string;
  sourceId?: string;
  studentId?: string;
  bulk?: MaterialBulkChoice;
};

export type MaterialIssueActionTarget =
  | { kind: "decision"; runId: string; decision: FeedbackIntakeDecision }
  | { kind: "unassigned"; source: MaterialUnassignedSource };

export type MaterialBulkOperation = MaterialBulkChoice & {
  targets: MaterialIssueActionTarget[];
};

const IGNORE_SOURCE_BULK = { key: "source:ignore", label: "全部忽略这些来源" };
const ACCEPT_SOURCE_BULK = { key: "source:accept", label: "全部采用为当前课次材料" };

export function materialIssueStage(issue: MaterialIssueActionInput): MaterialIssueStage {
  if (issue.stage) return issue.stage;
  if (issue.code?.includes("class_mismatch")) return "class";
  if (issue.code === "assessment_needs_match" || issue.code?.includes("student") || issue.code?.includes("identity")) return "student";
  if (issue.code?.includes("date") || issue.code?.includes("lesson")) return "session";
  return "fact";
}

export function selectedMaterialIssueDecision(
  issue: MaterialIssueActionInput,
  decisions: FeedbackIntakeDecision[],
) {
  return decisions.find((decision) => decision.issueId === issue.id)
    ?? decisions.find((decision) => issue.code !== "assessment_duplicate" && Boolean(issue.sourceName) && (
      issue.sourceId
        ? decision.sourceId === issue.sourceId
        : !decision.sourceId && decision.sourceName === issue.sourceName
    ) && (
      decision.action === "ignore_source"
      || (decision.action === "accept_source" && isSourceScopedBoundaryIssue({ code: issue.code ?? "" }))
    ));
}

function scoreCandidateBulk(sourceKind: string): MaterialBulkChoice | undefined {
  if (sourceKind === "assessment_pdf") return { key: "score:assessment_pdf", label: "全部采用出门测换算分" };
  if (sourceKind === "assistant_roster") return { key: "score:assistant_roster", label: "全部采用助教表评分" };
  if (sourceKind === "step_classroom") return { key: "score:step_classroom", label: "全部采用 STEP 评分" };
  return undefined;
}

export function materialIssueChoices(issue: MaterialIssueActionInput): MaterialIssueChoice[] {
  const stage = materialIssueStage(issue);
  if (stage === "class") {
    return [{ action: "ignore_source", label: "本轮不采用这个文件", bulk: IGNORE_SOURCE_BULK }];
  }
  if (stage === "session") {
    return [
      { action: "ignore_source", label: "本轮不采用这个文件", bulk: IGNORE_SOURCE_BULK },
      { action: "accept_source", label: "仍作为当前课次采用", bulk: ACCEPT_SOURCE_BULK },
    ];
  }
  if (stage === "student") {
    // 学生绑定与跳过都需要逐行确认，避免一次操作掩盖身份问题。
    return [{ action: "skip_student", label: "本轮不采用这一行" }];
  }
  if (issue.code === "attendance_conflict") {
    return [
      { action: "use_assistant", studentId: issue.attendanceConflict?.studentId, label: "采用助教表", bulk: { key: "attendance:assistant", label: "全部采用助教表考勤" } },
      { action: "use_step", studentId: issue.attendanceConflict?.studentId, label: "采用 STEP", bulk: { key: "attendance:step", label: "全部采用 STEP 考勤" } },
      { action: "skip_attendance", studentId: issue.attendanceConflict?.studentId, label: "不写考勤", bulk: { key: "attendance:skip", label: "全部不写考勤" } },
    ];
  }
  if (issue.code === "assessment_duplicate" && issue.assessmentDuplicate) {
    return issue.assessmentDuplicate.candidates.map((candidate) => ({
      action: "select_pdf",
      candidateId: candidate.id,
      sourceName: candidate.sourceName,
      sourceId: candidate.id,
      studentId: issue.assessmentDuplicate!.studentId,
      label: `采用 ${candidate.label}`,
    }));
  }
  if (issue.code === "score_conflict" && issue.scoreConflict) {
    const sourceCounts = new Map<string, number>();
    for (const candidate of issue.scoreConflict.candidates) {
      sourceCounts.set(candidate.sourceKind, (sourceCounts.get(candidate.sourceKind) ?? 0) + 1);
    }
    return [
      ...issue.scoreConflict.candidates.map((candidate) => ({
        action: "use_score_candidate" as const,
        candidateId: candidate.id,
        sourceName: candidate.sourceName,
        sourceId: candidate.sourceId,
        label: `采用${candidate.label}：${candidate.score}`,
        bulk: sourceCounts.get(candidate.sourceKind) === 1
          ? scoreCandidateBulk(candidate.sourceKind)
          : undefined,
      })),
      ...(issue.scoreConflict.candidates.some((candidate) => candidate.sourceKind === "current_metric")
        ? [{
            action: "skip_score" as const,
            label: `保留现有 ${issue.scoreConflict.dimension} 分`,
            bulk: { key: "score:preserve", label: "全部保留现有分数" },
          }]
        : []),
    ];
  }
  if (issue.code === "step_note_review") {
    return [
      { action: "use_observation", label: "采用备注", bulk: { key: "observation:use-note", label: "全部采用 STEP 备注" } },
      { action: "ignore_observation", label: "忽略备注", bulk: { key: "observation:ignore-note", label: "全部忽略 STEP 备注" } },
    ];
  }
  if (issue.code?.includes("observation")) {
    return [
      { action: "use_observation", label: "采用观察", bulk: { key: "observation:use", label: "全部采用课堂观察" } },
      { action: "ignore_observation", label: "忽略观察", bulk: { key: "observation:ignore", label: "全部忽略课堂观察" } },
    ];
  }
  return [{
    action: "ignore_source",
    label: "忽略来源",
    bulk: issue.unassignedSource
      ? { key: "source:ignore-unassigned", label: "全部忽略无法处理的文件" }
      : IGNORE_SOURCE_BULK,
  }];
}

export function materialChoiceSelected(
  decision: FeedbackIntakeDecision | undefined,
  choice: MaterialIssueChoice,
) {
  return (
    decision?.action === choice.action
    && (!["use_score_candidate", "select_pdf"].includes(choice.action) || decision.candidateId === choice.candidateId)
  ) || (choice.action === "use_observation" && decision?.action === "merge_observation");
}

export function materialIssueActionTarget(
  issue: MaterialIssueActionInput,
  choice: MaterialIssueChoice,
): MaterialIssueActionTarget | undefined {
  if (choice.action === "ignore_source" && issue.unassignedSource) {
    return { kind: "unassigned", source: issue.unassignedSource };
  }
  if (!issue.id || !issue.runId) return undefined;
  const sourceId = choice.sourceId ?? issue.sourceId;
  return {
    kind: "decision",
    runId: issue.runId,
    decision: {
      issueId: issue.id,
      action: choice.action,
      sourceName: choice.sourceName ?? issue.sourceName,
      ...(sourceId ? { sourceId } : {}),
      ...(choice.candidateId ? { candidateId: choice.candidateId } : {}),
      ...(choice.studentId ? { studentId: choice.studentId } : {}),
    },
  };
}

export function materialBulkOperations(issues: MaterialIssueActionInput[]): MaterialBulkOperation[] {
  const groups = new Map<string, MaterialBulkOperation>();
  for (const issue of issues) {
    for (const choice of materialIssueChoices(issue)) {
      if (!choice.bulk) continue;
      const target = materialIssueActionTarget(issue, choice);
      if (!target) continue;
      const group = groups.get(choice.bulk.key) ?? { ...choice.bulk, targets: [] };
      group.targets.push(target);
      groups.set(choice.bulk.key, group);
    }
  }
  return [...groups.values()].filter((operation) => operation.targets.length > 1);
}
