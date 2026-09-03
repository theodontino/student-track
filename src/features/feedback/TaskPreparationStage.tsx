"use client";

import Link from "next/link";
import { isBlockingFeedbackIntakeIssue, isSourceScopedBoundaryIssue } from "@/lib/feedback-intake-rules";
import type { FeedbackIntakeDecision } from "@/services/feedback-intake-service";
import type { FeedbackIntakeRunClient } from "./feedback-task-types";
import type { FeedbackTaskClassDraft, FeedbackTaskDraftV2 } from "./feedback-task-state";
import { MaterialIntakeCard, type GroupMaterialSummary, type MaterialSourceKind, type MaterialSourceSummary } from "./MaterialIntakeCard";
import styles from "./unified-feedback-workspace.module.css";

export type { GroupMaterialSummary, MaterialIssueSummary, MaterialSourceKind, MaterialSourceStatus, MaterialSourceSummary } from "./MaterialIntakeCard";

export type CommonMaterialOption = { value: string; label: string };

export type TaskPreparationStageProps = {
  draft: FeedbackTaskDraftV2;
  entry: FeedbackTaskClassDraft;
  run: FeedbackIntakeRunClient | null;
  studentTotal: number;
  busy: boolean;
  confirmDisabled?: boolean;
  commonMaterialLabel: string;
  commonMaterialPreview: string;
  commonMaterialOptions: CommonMaterialOption[];
  commonMaterialChoice: string;
  commonMaterialAction: "group" | "session" | "unavailable";
  commonMaterialHelp: string;
  decisions?: FeedbackIntakeDecision[];
  onFiles: (files: File[]) => void;
  onScan: () => void;
  onUseExistingFacts: () => void;
  onCommonMaterialChoice: (choice: string) => void;
  onContinue: () => void;
  manualFactsHref: string;
  onIgnoreUnassigned?: () => void;
  onDecision?: (runId: string, decision: FeedbackIntakeDecision) => void;
  materialSummary?: GroupMaterialSummary;
};

const SOURCE_KINDS: MaterialSourceKind[] = ["assistant_roster", "step_classroom", "assessment_pdf"];

function selectedDecision(issue: FeedbackIntakeRunClient["issues"][number], decisions: FeedbackIntakeDecision[]) {
  return decisions.find((decision) => decision.issueId === issue.id)
    ?? decisions.find((decision) => issue.sourceName && decision.sourceName === issue.sourceName && (
      decision.action === "ignore_source" || (decision.action === "accept_source" && isSourceScopedBoundaryIssue(issue))
    ));
}

function defaultMaterialSummary(run: FeedbackIntakeRunClient | null, entry: FeedbackTaskClassDraft, studentTotal: number, decisions: FeedbackIntakeDecision[]): GroupMaterialSummary {
  const pendingIssues = run?.status === "applied" ? [] : (run?.issues ?? []).filter(isBlockingFeedbackIntakeIssue);
  const sources: MaterialSourceSummary[] = SOURCE_KINDS.map((kind) => {
    const files = (run?.sourceManifest ?? []).filter((source) => source.kind === kind).map((source) => source.name ?? "未命名文件");
    const fileNames = new Set(files);
    const issues = pendingIssues.filter((issue) => issue.sourceName && fileNames.has(issue.sourceName));
    const unresolvedCount = issues.filter((issue) => !selectedDecision(issue, decisions)).length;
    const status = files.length === 0 ? "missing" : run?.status === "applied" ? "applied" : unresolvedCount > 0 ? "needs_review" : "ready";
    const summarizedIssues = issues.map((issue) => ({
      id: issue.id,
      code: issue.code,
      message: issue.message,
      runId: run?.id,
      className: entry.className,
      sourceName: issue.sourceName,
      candidates: issue.candidates,
      stage: issue.stage,
      rowNumber: issue.rowNumber,
      reportedStudent: issue.reportedStudent,
      rosterHint: issue.rosterHint,
      decision: selectedDecision(issue, decisions),
    }));
    const common = { kind, fileCount: files.length, issueCount: unresolvedCount, status, files, issues: summarizedIssues } satisfies MaterialSourceSummary;
    if (kind === "assessment_pdf") {
      const matched = run?.appliedSummary.assessmentStudentCount ?? Object.keys(run?.appliedSummary.assessmentEvidence ?? {}).length;
      return { ...common, matched, total: studentTotal, unit: "名学生" };
    }
    const hasClassFailure = issues.some((issue) => issue.code.endsWith("_class_mismatch") || issue.code.endsWith("_invalid"));
    if (kind !== "assistant_roster") return { ...common, matched: files.length > 0 && !hasClassFailure ? 1 : 0, total: 1, unit: "个班" };
    const facts = (run?.appliedSummary.sourceFacts ?? []).filter((fact) => fact.kind === "assistant_roster" && fileNames.has(fact.key));
    const matchedClass = facts.some((fact) => fact.assistantMatch?.matchedClass ?? !fact.issues?.some((issue) => issue.code === "assistant_class_mismatch"));
    const matchedStudents = facts.reduce((total, fact) => total + (fact.assistantMatch?.matchedStudents
      ?? fact.parsedResult?.students?.filter((student) => student.present !== false).length
      ?? 0), 0);
    const totalStudentRows = facts.reduce((total, fact) => total + (fact.assistantMatch?.totalStudentRows
      ?? (fact.parsedResult?.students?.filter((student) => student.present !== false).length ?? 0) + (fact.unresolvedStudents?.length ?? 0)), 0);
    const sessionState = issues.some((issue) => issue.code === "assistant_date_mismatch" || issue.code === "assistant_lesson_mismatch")
      ? "课次待确认"
      : issues.some((issue) => issue.code === "assistant_date_missing" || issue.code === "assistant_lesson_missing")
        ? "课次信息不完整"
        : "课次已匹配";
    return {
      ...common,
      matched: matchedClass ? 1 : 0,
      total: 1,
      unit: "个班",
      matchText: files.length ? `班级 ${matchedClass ? 1 : 0}/1 · 学生 ${matchedStudents}/${totalStudentRows} · ${sessionState}` : undefined,
    };
  });
  return {
    title: "本轮材料",
    scopeLabel: entry.className,
    issueCount: pendingIssues.filter((issue) => !selectedDecision(issue, decisions)).length,
    issues: pendingIssues.map((issue) => ({ id: issue.id, code: issue.code, message: issue.message })),
    sources,
  };
}

export function TaskPreparationStage(props: TaskPreparationStageProps) {
  const materialSummary = props.materialSummary ?? defaultMaterialSummary(props.run, props.entry, props.studentTotal, props.decisions ?? []);
  return <div className={styles.stageContent}>
    {props.draft.mode === "single" && <section className={styles.intakePaths}>
      <div><strong>先补录课堂记录</strong><span>可以像原来一样手动写课堂回顾；有助教表、STEP 或测评文件时，再在下面补充。</span></div>
      <Link className="ui-button ui-button--secondary ui-button--sm" href={props.manualFactsHref}>补录课堂记录</Link>
    </section>}
    <MaterialIntakeCard
      summary={materialSummary}
      busy={props.busy}
      confirmDisabled={props.confirmDisabled}
      onFiles={props.onFiles}
      onScan={props.onScan}
      onUseExistingFacts={props.onUseExistingFacts}
      useExistingFactsLabel={props.draft.mode === "group" ? "没有新材料，核对各班当前记录" : "没有新材料，核对当前记录"}
      onConfirm={props.onContinue}
      confirmLabel={props.draft.revisionSource ? "确认事实并按当前事实新建计划" : "确认事实并建立计划"}
      confirmHint={props.draft.revisionSource
        ? "将沿用原计划的范围与生成设置，读取刚确认的当前事实建立另一份计划；原计划和原正文不会修改。"
        : props.draft.mode === "group" ? "每个班分别确认；已完成班级会立即进入一份可恢复的计划草稿，未完成班级不会回滚。" : "确认课堂事实后立即建立可恢复的计划草稿；生成仍需在下一步单独启动。"}
      onIgnoreUnassigned={props.onIgnoreUnassigned}
      onDecision={props.onDecision}
    />
    <section className={styles.compactMaterialStrategy}>
      <div><strong>课程公共材料</strong><span>{props.commonMaterialLabel}</span></div>
      <label>本次课程材料<select value={props.commonMaterialChoice} disabled={props.busy || (props.commonMaterialAction === "unavailable" && props.commonMaterialOptions.length === 1)} onChange={(event) => props.onCommonMaterialChoice(event.target.value)}>{props.commonMaterialOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <small>{props.commonMaterialHelp}</small>
      {props.commonMaterialPreview && <details><summary>预览所选材料</summary><div className={styles.commonLessonPreview}>{props.commonMaterialPreview}</div></details>}
      {!props.commonMaterialOptions.some((option) => option.value.startsWith("library:")) && <Link className="ui-button ui-button--ghost ui-button--sm" href="/feedback/tools?tool=materials">管理学期公共材料</Link>}
      {props.commonMaterialAction === "group" && props.commonMaterialChoice.startsWith("library:") && <p>主按钮会同时确认并共享本讲材料，不需要再单独操作。</p>}
    </section>
  </div>;
}
