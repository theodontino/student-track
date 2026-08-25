"use client";

import { Badge, Button, StatusBanner } from "@/components/ui";
import { isBlockingFeedbackIntakeIssue, isSourceScopedBoundaryIssue } from "@/lib/feedback-intake-rules";
import type { FeedbackIntakeDecision, FeedbackIntakeDecisionAction, FeedbackIntakeIssue } from "@/services/feedback-intake-service";
import type { FeedbackIntakeRunClient } from "./feedback-task-types";
import type { FeedbackTaskClassDraft, FeedbackTaskDraftV2 } from "./feedback-task-state";
import styles from "./unified-feedback-workspace.module.css";

type Props = {
  draft: FeedbackTaskDraftV2;
  entry: FeedbackTaskClassDraft;
  runs: Record<string, FeedbackIntakeRunClient>;
  decisions: FeedbackIntakeDecision[];
  busy: boolean;
  onDecision: (decision: FeedbackIntakeDecision) => void;
  onConfirmFacts: () => void;
  onConfirmScope: () => void;
  onClear: () => void;
  onBack: () => void;
  onCreate: () => void;
};

function choiceFor(issue: FeedbackIntakeIssue): Array<{ action: FeedbackIntakeDecisionAction; label: string }> {
  if (issue.code === "attendance_conflict") return [{ action: "use_assistant", label: "采用助教表" }, { action: "use_step", label: "采用 STEP" }, { action: "skip_attendance", label: "不写考勤" }];
  if (issue.code.includes("observation")) return [{ action: "merge_observation", label: "合并观察" }, { action: "ignore_observation", label: "忽略观察" }];
  return [{ action: "ignore_source", label: "忽略来源" }, { action: "accept_source", label: "接受为当前课次" }];
}

function selectedDecision(issue: FeedbackIntakeIssue, decisions: FeedbackIntakeDecision[]) {
  return decisions.find((decision) => decision.issueId === issue.id)
    ?? decisions.find((decision) => issue.sourceName && decision.sourceName === issue.sourceName && (
      decision.action === "ignore_source" || (decision.action === "accept_source" && isSourceScopedBoundaryIssue(issue))
    ));
}

function issueLabel(issue: FeedbackIntakeIssue) {
  if (issue.code.includes("date") || issue.code.includes("lesson")) return "课次边界";
  if (issue.code.includes("student") || issue.code.includes("identity")) return "学生匹配";
  if (issue.code.includes("attendance")) return "考勤冲突";
  if (issue.code.startsWith("step")) return "STEP 边界";
  return "材料异常";
}

export function TaskConfirmationStage(props: Props) {
  const run = props.runs[props.entry.runId];
  const blocking = run?.issues.filter(isBlockingFeedbackIntakeIssue) ?? [];
  const unresolved = blocking.filter((issue) => !selectedDecision(issue, props.decisions));
  const factsConfirmed = run?.status === "applied";
  const scope = run?.appliedSummary.scopeConfirmation;
  const scopeConfirmed = Boolean(scope && scope.classId === props.entry.classId && scope.sessionCode === props.entry.sessionCode && scope.studentIds.length === props.entry.studentIds.length && props.entry.studentIds.every((id) => scope.studentIds.includes(id)));
  const allReady = factsConfirmed && scopeConfirmed;

  return <div className={styles.reviewStage}>
    <div className={styles.summaryStrip}><div><strong>{run?.appliedSummary.appliedStudentCount ?? run?.appliedSummary.parsedResult?.students?.length ?? 0}</strong><span>已整理学生事实</span></div><div><strong>{run?.appliedSummary.assessmentStudentCount ?? Object.keys(run?.appliedSummary.assessmentEvidence ?? {}).length}</strong><span>PDF 证据</span></div><div><strong>{blocking.length}</strong><span>阻断异常</span></div><div><strong>{unresolved.length}</strong><span>尚未选择</span></div></div>
    {run?.issues.some((issue) => !isBlockingFeedbackIntakeIssue(issue)) && <StatusBanner tone="info">{run.issues.filter((issue) => !isBlockingFeedbackIntakeIssue(issue)).length} 项提示不会阻止继续，例如旧学号按唯一姓名匹配。</StatusBanner>}
    {!factsConfirmed && blocking.length > 0 && <div className={styles.issueList}>{blocking.map((issue) => {
      const selected = selectedDecision(issue, props.decisions);
      return <article key={issue.id}><header><div><Badge tone="warning">{issueLabel(issue)}</Badge><strong>{issue.message}</strong></div><small>{issue.sourceName}</small></header>
        {issue.candidates?.length ? <div className={styles.choiceRow}><label>绑定学生 <select value={selected?.action === "bind_student" ? selected.studentId : ""} onChange={(event) => props.onDecision({ issueId: issue.id, action: "bind_student", studentId: event.target.value, sourceName: issue.sourceName })}><option value="">请选择</option>{issue.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.studentId}</option>)}</select></label><label><input type="radio" checked={selected?.action === "ignore_source"} onChange={() => props.onDecision({ issueId: issue.id, action: "ignore_source", sourceName: issue.sourceName })} />忽略该条</label></div>
          : <div className={styles.choiceRow}>{choiceFor(issue).map((choice) => <label key={choice.action}><input type="radio" name={issue.id} checked={selected?.action === choice.action} onChange={() => props.onDecision({ issueId: issue.id, action: choice.action, sourceName: issue.sourceName })} />{choice.label}</label>)}</div>}
      </article>;
    })}</div>}
    <details className={styles.allFacts}><summary>查看全部已整理事实（{run?.appliedSummary.parsedResult?.students?.length ?? 0} 名学生）</summary><div className={styles.factSources}>{run?.sourceManifest.map((source, index) => <article key={`${source.name}:${index}`}><strong>{source.kind ?? "来源"}</strong><span>{source.name}</span><small>已解析</small></article>)}</div></details>
    <section className={styles.classConfirmation}>
      <strong>{factsConfirmed ? "材料与事实已确认" : "第一步：确认本班材料与事实"}</strong>
      <p>{factsConfirmed ? "确定性事实已写入；计划尚未创建。" : unresolved.length ? `还有 ${unresolved.length} 项阻断异常需要选择。` : "确认后原子写入确定性课堂事实，不会确认学生范围。"}</p>
      {!factsConfirmed && <Button onClick={props.onConfirmFacts} disabled={props.busy || unresolved.length > 0}>确认本班材料与事实</Button>}
    </section>
    <section className={styles.classConfirmation}>
      <strong>{scopeConfirmed ? "班级、课次和反馈对象已确认" : "第二步：确认班级、课次和反馈对象"}</strong>
      <p>{props.entry.className} · {props.entry.sessionCode} · {props.entry.studentIds.length} 名反馈对象。此状态会保存到服务端。</p>
      {!scopeConfirmed && <Button onClick={props.onConfirmScope} disabled={props.busy || !factsConfirmed || !props.entry.studentIds.length}>确认班级、课次和反馈对象</Button>}
    </section>
    <div className={styles.actions}><div><Button variant="ghost" onClick={props.onBack} disabled={props.busy}>返回准备</Button><Button variant="ghost" onClick={props.onClear} disabled={props.busy}>清空本轮范围并重新选择</Button></div><div>{allReady && <Button onClick={props.onCreate} disabled={props.busy}>{props.draft.generationMode === "fast" ? "创建并开始快速草稿" : "创建并开始标准反馈"}</Button>}</div></div>
  </div>;
}
