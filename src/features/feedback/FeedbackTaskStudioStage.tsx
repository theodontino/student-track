"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { createEmptyLessonFeedbackMaterial } from "@/lib/feedback-materials";
import type { FeedbackContextResponse } from "./types";
import type { FeedbackPlanWorkspace } from "./FeedbackPlanPanel";
import { FeedbackPlanStudio } from "./FeedbackPlanStudio";
import type { FeedbackBatchClient } from "./feedback-task-types";
import styles from "./unified-feedback-workspace.module.css";

type Props = {
  semesterId: string;
  className: string;
  sessionCode: string;
  planId: string;
  batchId: string;
  context: FeedbackContextResponse | null;
  onPlanChange: (plan: { id: string; className: string; sessionCode: string }) => void;
  onNewTask: () => void;
};

const terminal = new Set(["paused", "failed", "completed", "archived"]);

export function FeedbackTaskStudioStage(props: Props) {
  const [batch, setBatch] = useState<FeedbackBatchClient | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadBatch = useCallback(async () => {
    if (!props.batchId) { setBatch(null); return null; }
    const result = await requestJson<{ batch: FeedbackBatchClient }>(`/api/report/feedback-plan-batches/${encodeURIComponent(props.batchId)}`);
    setBatch(result.batch); return result.batch;
  }, [props.batchId]);

  useEffect(() => { void loadBatch().catch((reason) => setError(reason instanceof Error ? reason.message : "读取班级组任务失败")); }, [loadBatch]);
  useEffect(() => {
    if (!batch || terminal.has(batch.status)) return;
    const timer = window.setInterval(() => void loadBatch().catch(() => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [batch, loadBatch]);

  const workspace = useMemo<FeedbackPlanWorkspace>(() => ({
    activeStep: "export",
    setActiveStep: () => undefined,
    draftId: "",
    confirmed: true,
    context: { semesterId: props.semesterId, className: props.className, sessionCode: props.sessionCode },
    lessonMaterial: props.context?.groupProgress?.lesson?.confirmedMaterial ?? props.context?.sessionCommonMaterial?.material ?? createEmptyLessonFeedbackMaterial(props.sessionCode),
    contextStudents: props.context?.students ?? [],
    confirmedAssessmentEvidence: {},
  }), [props.className, props.context, props.semesterId, props.sessionCode]);

  async function batchAction(action: "pause" | "continue" | "retry") {
    if (!props.batchId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await requestJson(`/api/report/feedback-plan-batches/${encodeURIComponent(props.batchId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      await loadBatch();
      setNotice(action === "pause" ? "已请求安全暂停整个班级组。" : action === "continue" ? "班级组生成已继续。" : "正在重试当前失败班级。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "班级组操作失败"); }
    finally { setBusy(false); }
  }

  if (!props.planId) return <StatusBanner tone="danger">任务已建立但缺少可打开的计划。请从“当前反馈任务”重新打开。</StatusBanner>;
  return <div className={styles.studioStage}>
    <header className={styles.studioHeader}><div><span className={styles.eyebrow}>第三阶段</span><h2>{batch ? "班级组生成与复核" : "生成与复核"}</h2><p>计划已落账；生成失败也会留在这里重试，不会退回确认页面。</p></div><Button variant="ghost" onClick={props.onNewTask}>结束本轮并新建任务</Button></header>
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}{notice && <StatusBanner tone="success">{notice}</StatusBanner>}
    {batch && <section className={styles.batchClasses}>
      <header><div><strong>班级组任务</strong><span>{batch.plans.length} 个独立计划 · {batch.status}</span></div><div className={styles.batchControls}>{["queued", "running", "pause_requested"].includes(batch.status) && <Button uiSize="sm" variant="secondary" onClick={() => void batchAction("pause")} disabled={busy || batch.status === "pause_requested"}>暂停整个班级组</Button>}{batch.status === "paused" && <Button uiSize="sm" variant="secondary" onClick={() => void batchAction("continue")} disabled={busy}>继续班级组生成</Button>}{batch.status === "failed" && <Button uiSize="sm" variant="secondary" onClick={() => void batchAction("retry")} disabled={busy}>重试失败班级</Button>}</div></header>
      <div>{batch.plans.map((plan) => <button type="button" key={plan.id} className={plan.id === props.planId ? styles.batchClassActive : ""} onClick={() => props.onPlanChange({ id: plan.id, className: plan.class.name ?? plan.class.code, sessionCode: plan.session?.code ?? "" })}><strong>{plan.class.name ?? plan.class.code}</strong><small>生成 {plan.progress.generated}/{plan.progress.total} · 批准 {plan.progress.approved} · 导出 {plan.progress.exported}</small></button>)}</div>
    </section>}
    <FeedbackPlanStudio workspace={workspace} batchControl={{ active: Boolean(batch), status: batch?.status ?? "", busy }} />
  </div>;
}
