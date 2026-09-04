"use client";

import { useRef, useState } from "react";
import { Button, Dialog, IconButton } from "@/components/ui";
import type { FeedbackIntakeDecision, FeedbackIntakeDecisionAction } from "@/services/feedback-intake-service";
import styles from "./unified-feedback-workspace.module.css";

export type MaterialSourceKind = "assistant_roster" | "step_classroom" | "assessment_pdf";
export type MaterialSourceStatus = "missing" | "ready" | "needs_review" | "applied";

export type MaterialIssueSummary = {
  id?: string;
  code?: string;
  message: string;
  runId?: string;
  className?: string;
  sourceName?: string;
  candidates?: Array<{ id: string; name: string; studentId: string }>;
  stage?: "class" | "student" | "session" | "fact";
  rowNumber?: number;
  reportedStudent?: { name: string; studentId: string };
  rosterHint?: string;
  decision?: FeedbackIntakeDecision;
};

export type MaterialSourceSummary = {
  kind: MaterialSourceKind;
  label?: string;
  matched?: number;
  total?: number;
  unit?: "个班" | "名学生";
  fileCount?: number;
  issueCount?: number;
  status: MaterialSourceStatus;
  files?: string[];
  issues?: MaterialIssueSummary[];
  matchText?: string;
};

export type GroupMaterialSummary = {
  title?: string;
  scopeLabel?: string;
  issueCount?: number;
  issues?: MaterialIssueSummary[];
  sources: MaterialSourceSummary[];
};

type NormalizedMaterialSource = MaterialSourceSummary & {
  label: string;
  fileCount: number;
  issueCount: number;
  files: string[];
  issues: MaterialIssueSummary[];
};

const SOURCE_PRESENTATION: Record<MaterialSourceKind, { label: string; description: string }> = {
  assistant_roster: { label: "助教 Excel", description: "班级、日期与考勤" },
  step_classroom: { label: "STEP 报告", description: "课堂观察与教师处理" },
  assessment_pdf: { label: "测评 ZIP / 文件夹", description: "按花名册绑定学生" },
};

const SOURCE_ORDER = Object.keys(SOURCE_PRESENTATION) as MaterialSourceKind[];
const STATUS_PRESENTATION: Record<MaterialSourceStatus, { icon: string; label: string }> = {
  missing: { icon: "—", label: "未添加" },
  ready: { icon: "✓", label: "已读取" },
  needs_review: { icon: "!", label: "需核对" },
  applied: { icon: "✓", label: "已确认" },
};

export function shouldAcceptMaterialFiles(busy: boolean, fileCount: number) {
  return !busy && fileCount > 0;
}

function normalizeSources(summary: GroupMaterialSummary): NormalizedMaterialSource[] {
  return SOURCE_ORDER.map((kind) => {
    const source = summary.sources.find((item) => item.kind === kind);
    const files = source?.files ?? [];
    const issues = source?.issues ?? [];
    return {
      kind,
      status: source?.status ?? "missing",
      ...source,
      label: source?.label ?? SOURCE_PRESENTATION[kind].label,
      fileCount: source?.fileCount ?? files.length,
      issueCount: source?.issueCount ?? issues.length,
      files,
      issues,
    };
  });
}

function fileSummary(source: NormalizedMaterialSource) {
  if (!source.files.length) return "尚未上传";
  if (source.files.length <= 2) return source.files.join("、");
  return `${source.files.slice(0, 2).join("、")}，另有 ${source.files.length - 2} 个`;
}

export function materialIssueChoices(issue: MaterialIssueSummary): Array<{ action: FeedbackIntakeDecisionAction; label: string }> {
  const stage = stageForIssue(issue);
  if (stage === "class") return [{ action: "ignore_source", label: "本轮不采用这个文件" }];
  if (stage === "session") return [{ action: "ignore_source", label: "本轮不采用这个文件" }, { action: "accept_source", label: "仍作为当前课次采用" }];
  if (stage === "student") return [{ action: "skip_student", label: "本轮不采用这一行" }];
  if (issue.code === "attendance_conflict") return [{ action: "use_assistant", label: "采用助教表" }, { action: "use_step", label: "采用 STEP" }, { action: "skip_attendance", label: "不写考勤" }];
  if (issue.code?.includes("observation")) return [{ action: "merge_observation", label: "合并观察" }, { action: "ignore_observation", label: "忽略观察" }];
  return [{ action: "ignore_source", label: "忽略来源" }];
}

function stageForIssue(issue: MaterialIssueSummary): NonNullable<MaterialIssueSummary["stage"]> {
  if (issue.stage) return issue.stage;
  if (issue.code?.includes("class_mismatch")) return "class";
  if (issue.code?.includes("student") || issue.code?.includes("identity")) return "student";
  if (issue.code?.includes("date") || issue.code?.includes("lesson")) return "session";
  return "fact";
}

const STAGE_PRESENTATION = {
  class: { title: "1. 班级匹配", description: "先确认材料属于当前班级或共同课范围。" },
  student: { title: "2. 学生匹配", description: "只在已匹配班级的 ACTIVE 花名册内核对学生。" },
  session: { title: "3. 课次核对", description: "最后核对日期和课次；系统不会自动切换当前课次。" },
  fact: { title: "其他事实核对", description: "确认考勤、观察和重复事实的采用方式。" },
} as const;

export function MaterialIssueDecision({ issue, busy, onDecision }: {
  issue: MaterialIssueSummary;
  busy: boolean;
  onDecision?: (runId: string, decision: FeedbackIntakeDecision) => void;
}) {
  const studentStage = stageForIssue(issue) === "student";
  return <>
    {studentStage && issue.reportedStudent && <p className={styles.materialReportedStudent}>表内学生：{issue.reportedStudent.name}{issue.reportedStudent.studentId ? ` · ${issue.reportedStudent.studentId}` : ""}{issue.rowNumber ? ` · 第 ${issue.rowNumber} 行` : ""}</p>}
    {issue.rosterHint && <p className={styles.materialRosterHint}>{issue.rosterHint}</p>}
    {studentStage && issue.candidates?.length ? <label>绑定当前班学生<select value={issue.decision?.action === "bind_student" ? issue.decision.studentId : ""} disabled={busy} onChange={(event) => issue.runId && onDecision?.(issue.runId, { issueId: issue.id ?? "", action: "bind_student", studentId: event.target.value, sourceName: issue.sourceName })}><option value="">请选择</option>{issue.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.studentId}</option>)}</select></label> : null}
    <div className={styles.choiceRow}>{materialIssueChoices(issue).map((choice) => <label key={choice.action}><input type="radio" name={`${issue.runId}:${issue.id}`} checked={issue.decision?.action === choice.action} disabled={busy} onChange={() => issue.runId && onDecision?.(issue.runId, { issueId: issue.id ?? "", action: choice.action, sourceName: issue.sourceName })} />{choice.label}</label>)}</div>
  </>;
}

function MaterialDetail({ source, busy, onAddFile, onAddFolder, onScan, onDecision }: {
  source: NormalizedMaterialSource;
  busy: boolean;
  onAddFile: () => void;
  onAddFolder: () => void;
  onScan: () => void;
  onDecision?: (runId: string, decision: FeedbackIntakeDecision) => void;
}) {
  const status = STATUS_PRESENTATION[source.status];
  return <div className={styles.materialDialog}>
    <div className={styles.materialDialogSummary}>
      <strong>{status.icon} {status.label}</strong>
      <span>{source.fileCount} 个文件{typeof source.matched === "number" && typeof source.total === "number" ? ` · 已匹配 ${source.matched}/${source.total} ${source.unit ?? ""}` : ""}</span>
    </div>
    {source.files.length > 0 && <section><strong>本轮采用文件</strong><ul>{source.files.map((file, index) => <li key={`${file}:${index}`}>{file}</li>)}</ul></section>}
    {source.issues.length > 0 && <section><strong>需要教师核对</strong><div className={styles.materialIssueStages}>{(["class", "student", "session", "fact"] as const).map((stage) => {
      const stageIssues = source.issues.filter((issue) => stageForIssue(issue) === stage);
      if (!stageIssues.length) return null;
      const presentation = STAGE_PRESENTATION[stage];
      if (stage === "session") {
        const groups = new Map<string, MaterialIssueSummary[]>();
        for (const item of stageIssues) {
          const key = `${item.runId ?? ""}\u0000${item.sourceName ?? ""}\u0000${item.className ?? ""}`;
          groups.set(key, [...(groups.get(key) ?? []), item]);
        }
        return <section key={stage} className={styles.materialIssueStage}><header><strong>{presentation.title}</strong><small>{presentation.description}</small></header>{[...groups.values()].map((items, groupIndex) => {
          const issue = items[0];
          return <article key={`${issue.id ?? "session"}:${groupIndex}`}>
            <div><strong>{issue.className ? `${issue.className} · ` : ""}课次不一致</strong>{issue.sourceName && <small>{issue.sourceName}</small>}</div>
            <ul>{items.map((item, index) => <li key={item.id ?? index}>{item.message}</li>)}</ul>
            <MaterialIssueDecision issue={issue} busy={busy} onDecision={onDecision} />
          </article>;
        })}</section>;
      }
      return <section key={stage} className={styles.materialIssueStage}><header><strong>{presentation.title}</strong><small>{presentation.description}</small></header><div className={styles.materialIssueChoices}>{stageIssues.map((issue, index) => <article key={issue.id ?? `${issue.message}:${index}`}>
        <div><strong>{issue.className ? `${issue.className} · ` : ""}{issue.message}</strong>{issue.sourceName && <small>{issue.sourceName}</small>}</div>
        <MaterialIssueDecision issue={issue} busy={busy} onDecision={onDecision} />
      </article>)}</div></section>;
    })}</div></section>}
    {source.status === "missing" && <p>这一来源是可选的；缺少它本身不会阻止确认。可以继续添加文件、选择文件夹或扫描收件箱。</p>}
    {source.status !== "missing" && source.issues.length === 0 && <p>{source.status === "applied" ? "这些文件已用于写入本轮课堂事实。" : "文件已读取，当前没有需要教师处理的异常。"}</p>}
    <div className={styles.materialDialogInbox}>收件箱：Student Track 数据目录中的 feedback-inbox<br />扫描不会移动或删除源文件。</div>
    <div className={styles.materialDialogActions}><Button variant="ghost" onClick={onScan}>扫描收件箱</Button><Button variant="ghost" onClick={onAddFolder}>选择文件夹</Button><Button variant="secondary" onClick={onAddFile}>添加文件</Button></div>
  </div>;
}

export function MaterialIntakeCard({ summary, busy, confirmDisabled, confirmLabel, confirmHint, onFiles, onScan, onConfirm, onUseExistingFacts, useExistingFactsLabel, onIgnoreUnassigned, onDecision }: {
  summary: GroupMaterialSummary;
  busy: boolean;
  confirmDisabled?: boolean;
  confirmLabel?: string;
  confirmHint?: string;
  onFiles: (files: File[]) => void;
  onScan: () => void;
  onConfirm: () => void;
  onUseExistingFacts?: () => void;
  useExistingFactsLabel?: string;
  onIgnoreUnassigned?: () => void;
  onDecision?: (runId: string, decision: FeedbackIntakeDecision) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [detailKind, setDetailKind] = useState<MaterialSourceKind | "unassigned" | null>(null);
  const sources = normalizeSources(summary);
  const detailSource = detailKind && detailKind !== "unassigned" ? sources.find((source) => source.kind === detailKind) ?? null : null;
  const fileCount = sources.reduce((total, source) => total + source.fileCount, 0);
  const issueCount = summary.issueCount ?? sources.reduce((total, source) => total + source.issueCount, 0);
  const sourceIssueKeys = new Set(sources.flatMap((source) => source.issues.map((issue) => issue.id ?? `${issue.code ?? ""}:${issue.message}`)));
  const unassignedIssues = (summary.issues ?? []).filter((issue) => !sourceIssueKeys.has(issue.id ?? `${issue.code ?? ""}:${issue.message}`));
  const unassignedIssueCount = Math.max(unassignedIssues.length, issueCount - sources.reduce((total, source) => total + source.issueCount, 0));

  function chooseFiles() { if (!busy) fileRef.current?.click(); }
  function chooseFolder() { if (!busy) folderRef.current?.click(); }
  function acceptFiles(files: File[]) { if (shouldAcceptMaterialFiles(busy, files.length)) onFiles(files); }

  return <section
    className={`${styles.materialIntake} ${dragging ? styles.materialIntakeDragging : ""}`}
    aria-labelledby="feedback-material-title"
    aria-busy={busy}
    onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
    onDragOver={(event) => event.preventDefault()}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); acceptFiles(Array.from(event.dataTransfer.files)); }}
  >
    <header className={styles.materialIntakeHeader}>
      <div><h3 id="feedback-material-title">{summary.title ?? "本轮材料"}</h3><p>Excel、STEP 和测评文件只用于补充本课事实；没有新材料也能继续核对当前课堂记录。</p></div>
      <div className={styles.materialIntakeSummary}>{summary.scopeLabel && <span>{summary.scopeLabel}</span>}<strong>{fileCount} 个文件</strong>{unassignedIssueCount > 0 && <button type="button" className={styles.materialOverallIssueButton} aria-haspopup="dialog" disabled={busy} onClick={() => setDetailKind("unassigned")}>{unassignedIssueCount} 项未归属</button>}</div>
    </header>

    <div className={styles.materialRows}>
      {sources.map((source) => {
        const status = STATUS_PRESENTATION[source.status];
        return <article key={source.kind} className={`${styles.materialRow} ${source.status === "needs_review" ? styles.materialRowWarning : ""}`}>
          <div className={styles.materialSourceName}><strong>{source.label}</strong><span title={fileSummary(source)}>{fileSummary(source)}</span></div>
          <div className={styles.materialSourceCounts}>{source.matchText ? <span className={styles.materialMatchText}>{source.matchText}</span> : typeof source.matched === "number" && typeof source.total === "number" ? <span className={styles.materialMatch}><strong>{source.matched}/{source.total}</strong> {source.unit ?? ""}</span> : <span>{SOURCE_PRESENTATION[source.kind].description}</span>}</div>
          <div className={`${styles.materialSourceStatus} ${source.status === "needs_review" ? styles.materialStatusWarning : source.status === "missing" ? styles.materialStatusMissing : ""}`}><span aria-hidden="true">{status.icon}</span><strong>{source.status === "needs_review" && source.issueCount > 0 ? `${source.issueCount} 项需核对` : status.label}</strong></div>
          <IconButton className={styles.materialMoreButton} label={`${source.label}：查看详情`} disabled={busy} onClick={() => setDetailKind(source.kind)}>⋯</IconButton>
        </article>;
      })}
    </div>

    <footer className={styles.materialIntakeActions}>
      <div><Button variant="secondary" onClick={chooseFiles} disabled={busy}>{fileCount ? "继续添加" : "添加文件"}</Button><Button variant="ghost" onClick={chooseFolder} disabled={busy}>选择文件夹</Button><Button variant="ghost" onClick={onScan} disabled={busy}>扫描收件箱</Button>{onUseExistingFacts && fileCount === 0 && <Button variant="ghost" onClick={onUseExistingFacts} disabled={busy}>{useExistingFactsLabel ?? "没有新材料，继续核对"}</Button>}</div>
      <div className={styles.materialConfirmAction}><small>{confirmHint ?? "确认后写入课堂事实，不创建反馈计划，也不调用模型。"}</small><Button onClick={onConfirm} disabled={busy || confirmDisabled}>{busy ? "处理中…" : confirmLabel ?? "确认事实并进入下一步"}</Button></div>
    </footer>
    <input ref={fileRef} hidden type="file" multiple disabled={busy} onChange={(event) => { acceptFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    <input ref={folderRef} hidden type="file" multiple disabled={busy} {...({ webkitdirectory: "" } as Record<string, string>)} onChange={(event) => { acceptFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />

    <Dialog open={Boolean(detailSource)} title={detailSource ? `${detailSource.label} 详情` : "材料详情"} onClose={() => setDetailKind(null)}>
      {detailSource && <MaterialDetail source={detailSource} busy={busy} onAddFile={() => { setDetailKind(null); chooseFiles(); }} onAddFolder={() => { setDetailKind(null); chooseFolder(); }} onScan={() => { setDetailKind(null); onScan(); }} onDecision={onDecision} />}
    </Dialog>
    <Dialog open={detailKind === "unassigned"} title="未归属材料" onClose={() => setDetailKind(null)}>
      <div className={styles.materialDialog}>
        <p>这些文件尚未归入所选班级或学生。处理、重新投料，或明确本轮不采用后才能继续。</p>
        {unassignedIssues.length > 0 ? <ul>{unassignedIssues.map((issue, index) => <li key={issue.id ?? `${issue.message}:${index}`}>{issue.message}</li>)}</ul> : <p>有 {unassignedIssueCount} 份材料需要处理。</p>}
        <div className={styles.materialDialogActions}>{onIgnoreUnassigned && <Button variant="ghost" onClick={() => { onIgnoreUnassigned(); setDetailKind(null); }}>明确本轮不采用</Button>}<Button variant="secondary" onClick={() => { setDetailKind(null); chooseFiles(); }}>重新投料</Button></div>
      </div>
    </Dialog>
  </section>;
}
