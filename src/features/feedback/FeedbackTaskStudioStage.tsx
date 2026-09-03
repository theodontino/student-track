"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { createEmptyLessonFeedbackMaterial } from "@/lib/feedback-materials";
import type { FeedbackContextResponse } from "./types";
import type { FeedbackPlanWorkspace } from "./FeedbackPlanPanel";
import { FeedbackPlanStudio } from "./FeedbackPlanStudio";
import type { FeedbackBatchClient, FeedbackStudioPlanTarget } from "./feedback-task-types";
import styles from "./unified-feedback-workspace.module.css";

type Props = {
  semesterId: string;
  className: string;
  sessionCode: string;
  planId: string;
  batchId: string;
  context: FeedbackContextResponse | null;
  onPlanChange: (plan: FeedbackStudioPlanTarget) => void;
  pendingClassCount?: number;
  onResumePending?: () => void;
  onNewTask: () => void;
};

export function shouldRefreshFeedbackTaskBatch(status: string) {
  return status !== "archived";
}

export function feedbackStudioPlanTarget(plan: FeedbackBatchClient["plans"][number]): FeedbackStudioPlanTarget {
  return {
    id: plan.id,
    classId: plan.class.id,
    className: plan.class.name ?? plan.class.code,
    sessionCode: plan.session?.code ?? plan.rangeEndSession?.code ?? "",
  };
}

export function feedbackStudioInitialPlanTarget(batch: FeedbackBatchClient | null, planId: string) {
  if (planId) return null;
  const first = batch?.plans[0];
  return first ? feedbackStudioPlanTarget(first) : null;
}

export function FeedbackTaskStudioStage(props: Props) {
  const { batchId, onPlanChange, planId } = props;
  const [batch, setBatch] = useState<FeedbackBatchClient | null>(null);
  const [batchFilter, setBatchFilter] = useState<"action" | "review" | "done" | "all">("action");
  const [focusItemId, setFocusItemId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadSequence = useRef(0);
  const resolvedInitialPlan = useRef("");

  const loadBatch = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const requestedBatchId = batchId;
    if (!requestedBatchId) { setBatch(null); return null; }
    const result = await requestJson<{ batch: FeedbackBatchClient }>(`/api/report/feedback-plan-batches/${encodeURIComponent(requestedBatchId)}`);
    if (sequence !== loadSequence.current) return null;
    setBatch(result.batch);
    setError("");
    return result.batch;
  }, [batchId]);

  useEffect(() => {
    void loadBatch().catch((reason) => setError(reason instanceof Error ? reason.message : "读取班级组计划失败"));
    return () => { loadSequence.current += 1; };
  }, [loadBatch]);
  useEffect(() => {
    if (planId) {
      resolvedInitialPlan.current = "";
      return;
    }
    const target = feedbackStudioInitialPlanTarget(batch, planId);
    if (!target || !batchId) return;
    const resolutionKey = `${batchId}:${target.id}`;
    if (resolvedInitialPlan.current === resolutionKey) return;
    resolvedInitialPlan.current = resolutionKey;
    onPlanChange(target);
  }, [batch, batchId, onPlanChange, planId]);
  useEffect(() => {
    if (!batch || !shouldRefreshFeedbackTaskBatch(batch.status)) return;
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

  const batchItems = useMemo(() => {
    type BatchItem = { id: string; status: string; studentId: string | null; student?: { id: string; name: string; studentId: string } | null };
    const plans = (batch?.plans ?? []) as Array<FeedbackBatchClient["plans"][number] & { items?: BatchItem[] }>;
    return plans.flatMap((plan) => (plan.items ?? []).map((item) => ({ item, plan })));
  }, [batch]);
  const visibleBatchItems = batchItems.filter(({ item }) => {
    if (batchFilter === "all") return true;
    if (batchFilter === "done") return ["approved", "exported"].includes(item.status);
    if (batchFilter === "review") return item.status === "needs_review";
    return !["approved", "exported"].includes(item.status);
  });

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

  if (!props.planId) return props.batchId && (!batch || batch.plans.length)
    ? <StatusBanner tone="info">正在打开班级组的首个班级计划…</StatusBanner>
    : <StatusBanner tone="danger">计划已建立但缺少可打开的班级单元。请从“当前反馈计划”重新打开。</StatusBanner>;
  return <div className={styles.studioStage}>
    <header className={styles.studioHeader}><div><span className={styles.eyebrow}>第三阶段</span><h2>{batch ? "班级组生成与复核" : "生成与复核"}</h2><p>计划已落账；生成失败也会留在这里重试，不会退回确认页面。</p></div><div className={styles.batchControls}>{Boolean(props.pendingClassCount && props.onResumePending) && <Button variant="secondary" onClick={props.onResumePending}>继续处理 {props.pendingClassCount} 个未完成班</Button>}<Button variant="ghost" onClick={props.onNewTask}>结束本轮并新建计划</Button></div></header>
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}{notice && <StatusBanner tone="success">{notice}</StatusBanner>}
    {batch && <><section className={styles.batchClasses}>
      <header><div><strong>班级组计划</strong><span>{batch.plans.length} 个真实班级 · 统一生成状态 {batch.status}</span></div><div className={styles.batchControls}>{["queued", "running", "pause_requested"].includes(batch.status) && <Button uiSize="sm" variant="secondary" onClick={() => void batchAction("pause")} disabled={busy || batch.status === "pause_requested"}>暂停整个班级组</Button>}{batch.status === "paused" && <Button uiSize="sm" variant="secondary" onClick={() => void batchAction("continue")} disabled={busy}>继续班级组生成</Button>}{batch.status === "failed" && <Button uiSize="sm" variant="secondary" onClick={() => void batchAction("retry")} disabled={busy}>重试失败班级</Button>}</div></header>
      <div>{batch.plans.map((plan) => <button type="button" key={plan.id} className={plan.id === props.planId ? styles.batchClassActive : ""} onClick={() => props.onPlanChange(feedbackStudioPlanTarget(plan))}><strong>{plan.class.name ?? plan.class.code}</strong><small>生成 {plan.progress.generated}/{plan.progress.total} · 批准 {plan.progress.approved} · 导出 {plan.progress.exported}</small></button>)}</div>
    </section>
    <section className={styles.batchClasses} aria-label="班级组学生复核导航">
      <header><div><strong>跨班学生清单</strong><span>按学生连续复核；班级只用于识别事实来源。</span></div><div className={styles.batchControls}>{(["action", "review", "done", "all"] as const).map((filter) => <Button key={filter} uiSize="sm" variant={batchFilter === filter ? "secondary" : "ghost"} onClick={() => setBatchFilter(filter)}>{filter === "action" ? "待处理" : filter === "review" ? "待复核" : filter === "done" ? "已完成" : "全部"} {batchItems.filter(({ item }) => filter === "all" || (filter === "done" ? ["approved", "exported"].includes(item.status) : filter === "review" ? item.status === "needs_review" : !["approved", "exported"].includes(item.status))).length}</Button>)}</div></header>
      <div>{visibleBatchItems.length ? visibleBatchItems.map(({ item, plan }) => <button type="button" key={item.id} className={focusItemId === item.id ? styles.batchClassActive : ""} onClick={() => { setFocusItemId(item.id); props.onPlanChange(feedbackStudioPlanTarget(plan)); }}><strong>{item.student?.name ?? "学生信息待加载"}</strong><small>{plan.class.name ?? plan.class.code} · {item.student?.studentId ?? item.status}</small></button>) : <span>当前筛选下没有学生</span>}</div>
    </section></>}
    <FeedbackPlanStudio workspace={workspace} focusItemId={focusItemId} batchControl={{ active: Boolean(batch), status: batch?.status ?? "", busy }} />
  </div>;
}
