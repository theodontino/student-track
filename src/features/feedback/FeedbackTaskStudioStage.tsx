"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { createEmptyLessonFeedbackMaterial } from "@/lib/feedback-materials";
import { feedbackGenerationApproachLabel } from "@/lib/feedback-generation-approach";
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

type QueueFilter = "action" | "review" | "done" | "all";
type QueueItem = FeedbackBatchClient["plans"][number]["items"][number];
type QueuePlan = FeedbackBatchClient["plans"][number];
type QueueTarget = { planId: string; itemId: string };
type QueueEntry = {
  item: Pick<QueueItem, "id" | "status">;
  plan: { id: string; class: { id: string } };
};

const filterLabels: Record<QueueFilter, string> = { action: "待处理", review: "待复核", done: "已完成", all: "全部" };
const itemStatusLabels: Record<string, string> = {
  evidence_ready: "待生成", queued: "排队中", generating: "生成中", pause_requested: "暂停中", paused: "已暂停",
  generation_failed: "生成失败", stale: "旧事实提示", needs_review: "待复核", approved: "已批准", exported: "已导出",
};

export function shouldRefreshFeedbackTaskBatch(status: string) {
  return status !== "archived";
}

export function feedbackStudioPlanTarget(plan: QueuePlan): FeedbackStudioPlanTarget {
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

export function feedbackQueueCategory(status: string): Exclude<QueueFilter, "all"> {
  if (status === "needs_review") return "review";
  if (status === "approved" || status === "exported") return "done";
  return "action";
}

export function feedbackQueueMatches(entry: QueueEntry, filter: QueueFilter, classFilter: string) {
  return (classFilter === "all" || entry.plan.class.id === classFilter)
    && (filter === "all" || feedbackQueueCategory(entry.item.status) === filter);
}

export function defaultFeedbackQueueFilter(queue: readonly QueueEntry[], classFilter: string): QueueFilter {
  const scoped = queue.filter((entry) => classFilter === "all" || entry.plan.class.id === classFilter);
  return (["action", "review", "done"] as const).find((filter) => scoped.some((entry) => feedbackQueueCategory(entry.item.status) === filter)) ?? "action";
}

export function resolveFeedbackQueueTarget(
  queue: readonly QueueEntry[],
  filter: QueueFilter,
  classFilter: string,
  target: QueueTarget,
): QueueTarget | null {
  const filtered = queue.filter((entry) => feedbackQueueMatches(entry, filter, classFilter));
  const current = filtered.find((entry) => entry.plan.id === target.planId && entry.item.id === target.itemId);
  const resolved = current ?? filtered[0];
  return resolved ? { planId: resolved.plan.id, itemId: resolved.item.id } : null;
}

function initialUrlValue(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return new URLSearchParams(window.location.search).get(name) || fallback;
}

function initialQueueFilter() {
  const value = initialUrlValue("queue", "");
  return value === "action" || value === "review" || value === "done" || value === "all" ? value : null;
}

function writeQueueUrl(values: { itemId?: string; queue?: QueueFilter | null; classId?: string }) {
  const url = new URL(window.location.href);
  if (values.itemId) url.searchParams.set("itemId", values.itemId); else url.searchParams.delete("itemId");
  if (values.queue) url.searchParams.set("queue", values.queue); else url.searchParams.delete("queue");
  if (values.classId && values.classId !== "all") url.searchParams.set("scopeClassId", values.classId); else url.searchParams.delete("scopeClassId");
  const search = url.searchParams.toString();
  window.history.replaceState(window.history.state, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
}

function singlePlanAsQueuePlan(plan: {
  id: string; status: string; class: QueuePlan["class"]; session?: QueuePlan["session"]; rangeEndSession?: QueuePlan["rangeEndSession"];
  items: QueueItem[]; generationProgress?: { total: number; completed: number; failed: number };
}): QueuePlan {
  const generated = plan.items.filter((item) => ["needs_review", "approved", "exported"].includes(item.status)).length;
  return {
    ...plan,
    progress: {
      total: plan.items.length,
      generated,
      approved: plan.items.filter((item) => item.status === "approved").length,
      exported: plan.items.filter((item) => item.status === "exported").length,
      failed: plan.items.filter((item) => item.status === "generation_failed").length,
    },
  };
}

export function FeedbackTaskStudioStage(props: Props) {
  const { batchId, onPlanChange, planId } = props;
  const [batch, setBatch] = useState<FeedbackBatchClient | null>(null);
  const [singlePlan, setSinglePlan] = useState<QueuePlan | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<QueueFilter | null>(initialQueueFilter);
  const [classFilter, setClassFilter] = useState(() => initialUrlValue("scopeClassId", "all"));
  const [target, setTarget] = useState<QueueTarget>(() => ({ planId, itemId: initialUrlValue("itemId", "") }));
  const [queueOpen, setQueueOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loadSequence = useRef(0);
  const resolvedInitialPlan = useRef("");

  const loadPlans = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (batchId) {
      const result = await requestJson<{ batch: FeedbackBatchClient }>(`/api/report/feedback-plan-batches/${encodeURIComponent(batchId)}`);
      if (sequence !== loadSequence.current) return null;
      setBatch(result.batch); setSinglePlan(null); setError("");
      return result.batch;
    }
    if (!planId) { setBatch(null); setSinglePlan(null); return null; }
    const result = await requestJson<{ plan: Parameters<typeof singlePlanAsQueuePlan>[0] }>(`/api/report/feedback-plans/${encodeURIComponent(planId)}`);
    if (sequence !== loadSequence.current) return null;
    setSinglePlan(singlePlanAsQueuePlan(result.plan)); setBatch(null); setError("");
    return null;
  }, [batchId, planId]);

  useEffect(() => {
    void loadPlans().catch((reason) => setError(reason instanceof Error ? reason.message : "读取反馈计划失败"));
    return () => { loadSequence.current += 1; };
  }, [loadPlans]);
  useEffect(() => {
    if (planId) { resolvedInitialPlan.current = ""; return; }
    const target = feedbackStudioInitialPlanTarget(batch, planId);
    if (!target || !batchId) return;
    const key = `${batchId}:${target.id}`;
    if (resolvedInitialPlan.current === key) return;
    resolvedInitialPlan.current = key; onPlanChange(target);
  }, [batch, batchId, onPlanChange, planId]);
  useEffect(() => {
    const status = batch?.status ?? singlePlan?.status;
    if (!status || !shouldRefreshFeedbackTaskBatch(status)) return;
    const timer = window.setInterval(() => void loadPlans().catch(() => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [batch?.status, loadPlans, singlePlan?.status]);

  const workspace = useMemo<FeedbackPlanWorkspace>(() => ({
    activeStep: "export", setActiveStep: () => undefined, draftId: "", confirmed: true,
    context: { semesterId: props.semesterId, className: props.className, sessionCode: props.sessionCode },
    lessonMaterial: props.context?.groupProgress?.lesson?.confirmedMaterial ?? props.context?.sessionCommonMaterial?.material ?? createEmptyLessonFeedbackMaterial(props.sessionCode),
    contextStudents: props.context?.students ?? [], confirmedAssessmentEvidence: {},
  }), [props.className, props.context, props.semesterId, props.sessionCode]);

  const plans = useMemo(() => batch?.plans ?? (singlePlan ? [singlePlan] : []), [batch?.plans, singlePlan]);
  const queue = useMemo(() => plans.flatMap((plan) => plan.items.map((item) => ({ item, plan }))), [plans]);
  const filter = selectedFilter ?? defaultFeedbackQueueFilter(queue, classFilter);
  const filteredQueue = queue.filter((entry) => feedbackQueueMatches(entry, filter, classFilter));
  const counts = (Object.keys(filterLabels) as QueueFilter[]).reduce<Record<QueueFilter, number>>((result, key) => {
    result[key] = queue.filter((entry) => feedbackQueueMatches(entry, key, classFilter)).length;
    return result;
  }, { action: 0, review: 0, done: 0, all: 0 });
  const queueReady = batchId ? batch?.id === batchId : singlePlan?.id === planId;

  useEffect(() => {
    if (!queueReady) return;
    const resolved = resolveFeedbackQueueTarget(queue, filter, classFilter, { planId: target.planId, itemId: target.itemId });
    if (!resolved) {
      if (!target.itemId && !target.planId) return;
      setTarget({ planId: "", itemId: "" });
      writeQueueUrl({ itemId: "", queue: selectedFilter, classId: classFilter });
      return;
    }
    if (resolved.itemId === target.itemId && resolved.planId === target.planId) return;
    setTarget(resolved);
    const entry = queue.find(({ item, plan }) => item.id === resolved.itemId && plan.id === resolved.planId);
    if (entry && entry.plan.id !== planId) onPlanChange(feedbackStudioPlanTarget(entry.plan));
    writeQueueUrl({ itemId: resolved.itemId, queue: selectedFilter, classId: classFilter });
  }, [classFilter, filter, onPlanChange, planId, queue, queueReady, selectedFilter, target.itemId, target.planId]);

  function selectItem(plan: QueuePlan, item: QueueItem) {
    setTarget({ planId: plan.id, itemId: item.id }); setQueueOpen(false);
    writeQueueUrl({ itemId: item.id, queue: selectedFilter, classId: classFilter });
    if (plan.id !== planId) onPlanChange(feedbackStudioPlanTarget(plan));
  }

  function changeFilter(next: QueueFilter) {
    setSelectedFilter(next);
    const resolved = resolveFeedbackQueueTarget(queue, next, classFilter, target);
    const entry = resolved ? queue.find(({ item, plan }) => item.id === resolved.itemId && plan.id === resolved.planId) : null;
    if (entry && resolved) {
      setTarget(resolved); setQueueOpen(false);
      writeQueueUrl({ itemId: resolved.itemId, queue: next, classId: classFilter });
      if (entry.plan.id !== planId) onPlanChange(feedbackStudioPlanTarget(entry.plan));
    }
    else {
      setTarget({ planId: "", itemId: "" });
      writeQueueUrl({ itemId: "", queue: next, classId: classFilter });
    }
  }

  function changeClassFilter(next: string) {
    setClassFilter(next);
    const nextFilter = selectedFilter ?? defaultFeedbackQueueFilter(queue, next);
    const resolved = resolveFeedbackQueueTarget(queue, nextFilter, next, target);
    const entry = resolved ? queue.find(({ item, plan }) => item.id === resolved.itemId && plan.id === resolved.planId) : null;
    if (entry && resolved) {
      setTarget(resolved); setQueueOpen(false);
      writeQueueUrl({ itemId: resolved.itemId, queue: selectedFilter, classId: next });
      if (entry.plan.id !== planId) onPlanChange(feedbackStudioPlanTarget(entry.plan));
    } else {
      setTarget({ planId: "", itemId: "" });
      writeQueueUrl({ itemId: "", queue: selectedFilter, classId: next });
    }
  }

  function nextItem(currentItemId: string) {
    const index = filteredQueue.findIndex(({ item }) => item.id === currentItemId);
    const next = filteredQueue[index + 1] ?? filteredQueue[0];
    if (next) selectItem(next.plan, next.item);
  }

  async function batchAction(action: "pause" | "continue" | "retry" | "retry_with_free") {
    if (!batchId) return;
    if (action === "retry_with_free" && !window.confirm("将当前班级组中失败和尚未开始的条目改用自由反馈？\n\n已成功的结果、正文和记录不会改变。")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await requestJson(`/api/report/feedback-plan-batches/${encodeURIComponent(batchId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      await loadPlans();
      setNotice(action === "pause" ? "已请求安全暂停整个班级组。" : action === "continue" ? "班级组生成已继续。" : action === "retry_with_free" ? "失败和尚未开始的条目正改用自由反馈。" : "正在重试当前失败班级。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "班级组操作失败"); }
    finally { setBusy(false); }
  }

  if (!planId) return batchId && (!batch || batch.plans.length)
    ? <StatusBanner tone="info">正在打开班级组的首个班级计划…</StatusBanner>
    : <StatusBanner tone="danger">计划已建立但缺少可打开的班级单元。请从“反馈计划”重新打开。</StatusBanner>;
  const activeQueueEntry = filteredQueue.find(({ item, plan }) => item.id === target.itemId && plan.id === target.planId);
  return <div className={styles.studioStage}>
    <header className={styles.studioHeader}><div><span className={styles.eyebrow}>第三阶段</span><h2>{batch ? "班级组生成与复核" : "生成与复核"}</h2><p>计划已落账；生成、批准和导出分别记录，失败项留在队列中重试。{batch ? `计划方式：${feedbackGenerationApproachLabel(batch.generationApproach)}` : ""}</p></div><div className={styles.batchControls}>{Boolean(props.pendingClassCount && props.onResumePending) && <Button variant="secondary" onClick={props.onResumePending}>继续处理 {props.pendingClassCount} 个未完成班</Button>}{batch && ["queued", "running", "pause_requested"].includes(batch.status) && <Button variant="secondary" onClick={() => void batchAction("pause")} disabled={busy}>暂停整批</Button>}{batch?.status === "paused" && <Button variant="secondary" onClick={() => void batchAction("continue")} disabled={busy}>继续整批</Button>}{batch?.status === "failed" && <Button variant="secondary" onClick={() => void batchAction("retry")} disabled={busy}>重试失败班级</Button>}{batch?.status === "failed" && batch.generationApproach === "restricted" && <Button variant="secondary" onClick={() => void batchAction("retry_with_free")} disabled={busy}>改用自由反馈</Button>}<Button variant="ghost" onClick={props.onNewTask}>归档当前计划并新建</Button></div></header>
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}{notice && <StatusBanner tone="success">{notice}</StatusBanner>}
    <button type="button" className="feedback-queue-mobile-trigger" onClick={() => setQueueOpen(true)}>{activeQueueEntry ? `${activeQueueEntry.item.student?.name ?? "反馈队列"} · ${itemStatusLabels[activeQueueEntry.item.status] ?? "选择条目"} · ${filteredQueue.findIndex(({ item, plan }) => item.id === target.itemId && plan.id === target.planId) + 1}/${filteredQueue.length}` : "当前筛选下没有学生任务"}</button>
    <div className="feedback-unified-studio">
      {queueOpen && <button type="button" className="feedback-queue-backdrop" aria-label="关闭反馈队列" onClick={() => setQueueOpen(false)} />}
      <aside className={`feedback-queue ${queueOpen ? "is-open" : ""}`} aria-label="反馈队列">
        <header><div><strong>反馈队列</strong><span>按班级与任务状态筛选；一次只处理一条</span></div><Button uiSize="sm" variant="ghost" onClick={() => setQueueOpen(false)}>关闭</Button></header>
        {plans.length > 1 && <label className="feedback-queue-class-filter">班级<select value={classFilter} onChange={(event) => changeClassFilter(event.target.value)}><option value="all">全部班级</option>{plans.map((plan) => <option key={plan.id} value={plan.class.id}>{plan.class.name ?? plan.class.code}</option>)}</select></label>}
        <div className="feedback-plan-studio-filters">{(Object.keys(filterLabels) as QueueFilter[]).map((key) => <button type="button" key={key} aria-pressed={filter === key} className={filter === key ? "is-active" : ""} onClick={() => changeFilter(key)}>{filterLabels[key]}<small>{counts[key]}</small></button>)}</div>
        <nav className="feedback-queue-groups">{!filteredQueue.length
          ? <p className="feedback-queue-empty" role="status">当前班级与任务状态下没有学生任务。</p>
          : plans.filter((plan) => (classFilter === "all" || plan.class.id === classFilter) && plan.items.some((item) => feedbackQueueMatches({ item, plan }, filter, classFilter))).map((plan) => <section key={plan.id}><header><div><strong>{plan.class.name ?? plan.class.code}</strong><small>{feedbackGenerationApproachLabel(plan.generationApproach)} · 生成 {plan.progress.generated}/{plan.progress.total} · 批准 {plan.progress.approved} · 导出 {plan.progress.exported}</small></div>{plan.progress.failed > 0 && <Badge tone="danger">失败 {plan.progress.failed}</Badge>}</header><div>{plan.items.filter((item) => feedbackQueueMatches({ item, plan }, filter, classFilter)).map((item) => { const active = target.planId === plan.id && target.itemId === item.id; const attempts = item.generationExecution?.attempts ?? []; const actualApproach = attempts[attempts.length - 1]?.actualApproach; return <button type="button" key={`${plan.id}:${item.id}`} aria-current={active ? "true" : undefined} className={active ? "is-active" : ""} onClick={() => selectItem(plan, item)}><span><strong>{item.student?.name ?? (item.studentId ? "学生信息待加载" : "班级公共反馈")}</strong><small>{item.student?.studentId ?? (item.studentId ? "身份待加载" : "公共条目")} · {plan.class.name ?? plan.class.code} · {actualApproach ? `${feedbackGenerationApproachLabel(actualApproach)}实际执行` : "尚未执行"}</small></span><Badge tone={feedbackQueueCategory(item.status) === "done" ? "success" : item.status === "generation_failed" || item.status === "stale" ? "danger" : "warning"}>{itemStatusLabels[item.status] ?? item.status}</Badge></button>; })}</div></section>)}</nav>
      </aside>
      <div className="feedback-unified-studio__content" aria-label="计划条目详情">{activeQueueEntry
        ? <FeedbackPlanStudio workspace={workspace} focusItemId={activeQueueEntry.item.id} externalNavigator onNextItem={nextItem} batchControl={{ active: Boolean(batch), status: batch?.status ?? "", busy }} />
        : <StatusBanner tone="info">{queueReady ? "当前班级与任务状态下没有学生任务，请调整左侧筛选。" : "正在读取反馈队列…"}</StatusBanner>}</div>
    </div>
  </div>;
}
