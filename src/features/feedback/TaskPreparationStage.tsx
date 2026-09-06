"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button, Dialog, StatusBanner, Textarea } from "@/components/ui";
import { ScoreDimensionLegend } from "@/components/ScoreDimensionLegend";
import { isBlockingFeedbackIntakeIssue } from "@/lib/feedback-intake-rules";
import type { LessonFeedbackMaterial } from "@/lib/feedback-materials";
import type { FeedbackIntakeDecision } from "@/services/feedback-intake-service";
import type { FeedbackIntakeRunClient } from "./feedback-task-types";
import type { FeedbackTaskClassDraft, FeedbackTaskDraftV2 } from "./feedback-task-state";
import { MaterialIntakeCard, type GroupMaterialSummary, type MaterialIssueSummary, type MaterialSourceKind, type MaterialSourceSummary } from "./MaterialIntakeCard";
import { selectedMaterialIssueDecision } from "./material-issue-actions";
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
  sessionMaterial?: Pick<LessonFeedbackMaterial, "groupFeedbackRaw" | "assessmentBriefRaw"> | null;
  decisions?: FeedbackIntakeDecision[];
  onFiles: (files: File[]) => void;
  onScan: () => void;
  onUseExistingFacts: () => void;
  onCommonMaterialChoice: (choice: string) => void;
  onSaveSessionMaterial?: (input: { groupFeedbackRaw: string; assessmentBriefRaw: string }) => Promise<void>;
  onContinue: () => void;
  manualFactsHref: string;
  semesterMaterialsHref?: string;
  onIgnoreUnassigned?: () => void;
  onIgnoreUnassignedSource?: (source: NonNullable<MaterialIssueSummary["unassignedSource"]>) => void;
  onDecision?: (runId: string, decision: FeedbackIntakeDecision) => void;
  materialSummary?: GroupMaterialSummary;
};

const SOURCE_KINDS: MaterialSourceKind[] = ["assistant_roster", "step_classroom", "assessment_pdf"];

function selectedDecision(issue: FeedbackIntakeRunClient["issues"][number], decisions: FeedbackIntakeDecision[]) {
  return selectedMaterialIssueDecision(issue, decisions);
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
      sourceId: issue.sourceId,
      candidates: issue.candidates,
      stage: issue.stage,
      rowNumber: issue.rowNumber,
      reportedStudent: issue.reportedStudent,
      rosterHint: issue.rosterHint,
      scoreConflict: issue.scoreConflict,
      assessmentDuplicate: issue.assessmentDuplicate,
      attendanceConflict: issue.attendanceConflict,
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
    issues: pendingIssues.map((issue) => ({
      id: issue.id,
      code: issue.code,
      message: issue.message,
      runId: run?.id,
      className: entry.className,
      sourceName: issue.sourceName,
      sourceId: issue.sourceId,
      candidates: issue.candidates,
      stage: issue.stage,
      rowNumber: issue.rowNumber,
      reportedStudent: issue.reportedStudent,
      rosterHint: issue.rosterHint,
      scoreConflict: issue.scoreConflict,
      assessmentDuplicate: issue.assessmentDuplicate,
      attendanceConflict: issue.attendanceConflict,
      decision: selectedDecision(issue, decisions),
    })),
    sources,
  };
}

export function TaskPreparationStage(props: TaskPreparationStageProps) {
  const materialSummary = props.materialSummary ?? defaultMaterialSummary(props.run, props.entry, props.studentTotal, props.decisions ?? []);
  const [sessionMaterialDialogOpen, setSessionMaterialDialogOpen] = useState(false);
  const [sessionMaterialSaving, setSessionMaterialSaving] = useState(false);
  const [sessionMaterialError, setSessionMaterialError] = useState("");
  const [groupFeedbackRaw, setGroupFeedbackRaw] = useState("");
  const [assessmentBriefRaw, setAssessmentBriefRaw] = useState("");

  function openSessionMaterialDialog() {
    setGroupFeedbackRaw(props.sessionMaterial?.groupFeedbackRaw ?? "");
    setAssessmentBriefRaw(props.sessionMaterial?.assessmentBriefRaw ?? "");
    setSessionMaterialError("");
    setSessionMaterialDialogOpen(true);
  }

  async function saveSessionMaterial(event: FormEvent) {
    event.preventDefault();
    if (!props.onSaveSessionMaterial) return;
    setSessionMaterialSaving(true);
    setSessionMaterialError("");
    try {
      await props.onSaveSessionMaterial({ groupFeedbackRaw, assessmentBriefRaw });
      setSessionMaterialDialogOpen(false);
    } catch (error) {
      setSessionMaterialError(error instanceof Error ? error.message : "保存本课背景失败");
    } finally {
      setSessionMaterialSaving(false);
    }
  }

  return <div className={styles.stageContent}>
    {props.draft.mode === "single" && <section className={styles.intakePaths}>
      <div><strong>先补录课堂记录</strong><span>可以像原来一样手动写课堂回顾；有助教表、STEP 或测评文件时，再在下面补充。</span></div>
      <Link className="ui-button ui-button--secondary ui-button--sm" href={props.manualFactsHref}>补录课堂记录</Link>
    </section>}
    <ScoreDimensionLegend showAssessmentRule />
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
      onIgnoreUnassignedSource={props.onIgnoreUnassignedSource}
      onDecision={props.onDecision}
    />
    <section className={styles.compactMaterialStrategy}>
      <div><strong>本课课程背景（可选）</strong><span>{props.commonMaterialLabel}</span></div>
      <label>本次课程材料<select value={props.commonMaterialChoice} disabled={props.busy || (props.commonMaterialAction === "unavailable" && props.commonMaterialOptions.length === 1)} onChange={(event) => props.onCommonMaterialChoice(event.target.value)}>{props.commonMaterialOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <small>{props.commonMaterialHelp}</small>
      {props.commonMaterialPreview && <details><summary>预览所选材料</summary><div className={styles.commonLessonPreview}>{props.commonMaterialPreview}</div></details>}
      {props.commonMaterialAction === "session" && props.onSaveSessionMaterial && <Button variant="ghost" uiSize="sm" onClick={openSessionMaterialDialog} disabled={props.busy}>{props.sessionMaterial ? "编辑本课背景" : "自定义本课背景"}</Button>}
      {!props.commonMaterialOptions.some((option) => option.value.startsWith("library:")) && <Link className="ui-button ui-button--ghost ui-button--sm" href={props.semesterMaterialsHref ?? "/semesters"}>管理学期公共材料</Link>}
      {props.commonMaterialAction === "group" && props.commonMaterialChoice.startsWith("library:") && <p>主按钮会同时确认并共享本讲材料，不需要再单独操作。</p>}
    </section>
    <Dialog open={sessionMaterialDialogOpen} title="自定义本课课程背景" onClose={() => { if (!sessionMaterialSaving) setSessionMaterialDialogOpen(false); }}>
      <form className="dialog-form" onSubmit={(event) => void saveSessionMaterial(event)}>
        {sessionMaterialError && <StatusBanner tone="danger">{sessionMaterialError}</StatusBanner>}
        <label>班级公共反馈或课程材料<Textarea rows={7} value={groupFeedbackRaw} disabled={sessionMaterialSaving} onChange={(event) => setGroupFeedbackRaw(event.target.value)} /></label>
        <label>统一测评说明<Textarea rows={5} value={assessmentBriefRaw} disabled={sessionMaterialSaving} onChange={(event) => setAssessmentBriefRaw(event.target.value)} /></label>
        <p className="dialog-form__hint">这份背景只保存到当前独立课次；进入计划时会复制进计划快照，不会改动学期材料库。</p>
        <div className="dialog-form__actions"><Button variant="secondary" onClick={() => setSessionMaterialDialogOpen(false)} disabled={sessionMaterialSaving}>取消</Button><Button type="submit" disabled={sessionMaterialSaving}>{sessionMaterialSaving ? "保存中…" : "保存并用于本次计划"}</Button></div>
      </form>
    </Dialog>
  </div>;
}
