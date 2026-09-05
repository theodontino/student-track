"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, Drawer, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { feedbackGenerationApproachLabel, type FeedbackGenerationApproach } from "@/lib/feedback-generation-approach";
import { feedbackPlanActionBucket as deriveFeedbackPlanActionBucket, type FeedbackPlanActionBucket } from "@/lib/feedback-plan-summary";
import styles from "./feedback-plan-manager.module.css";

export type FeedbackPlanSummary = {
  id: string; displayName?: string | null; type: string; status: string; archivedAt?: string | null; batchId?: string | null;
  updatedAt?: string; actionBucket?: FeedbackPlanActionBucket; legacyReadonly?: boolean;
  generationApproach?: FeedbackGenerationApproach | null; generationApproachLabel?: string;
  session?: { code: string } | null; rangeEndSession?: { code: string } | null;
  class?: { id: string; code: string; name?: string | null } | null;
  semester?: { id: string; name: string } | null;
  itemStatusCounts: {
    total: number; queued: number; running: number; completed: number; failed: number;
    evidenceReady?: number; paused?: number; needsReview?: number; approved?: number; exported?: number; stale?: number;
  };
};

export type FeedbackPlanBatchSummary = {
  id: string; displayName?: string | null; type: string; status: string; archivedAt?: string | null; semester?: { id: string; name: string } | null;
  updatedAt?: string; actionBucket?: FeedbackPlanActionBucket; legacyReadonly?: boolean;
  generationApproach?: FeedbackGenerationApproach | null; generationApproachLabel?: string;
  plans: Array<{ id: string; class: { id: string; code: string; name?: string | null }; session?: { code: string } | null; rangeEndSession?: { code: string } | null }>;
  progress: { total: number; generated: number; approved: number; exported: number; failed: number; completedClasses: number; totalClasses: number };
  itemStatusCounts?: {
    total: number; evidenceReady: number; queued: number; running: number; paused: number; failed: number;
    needsReview: number; approved: number; exported: number; stale: number; completed: number;
  };
};

export type FeedbackPlanTaskRow = { kind: "plan"; id: string; plan: FeedbackPlanSummary } | { kind: "batch"; id: string; batch: FeedbackPlanBatchSummary };
export type ArchivedFeedbackTaskReference = {
  kind: "plan" | "batch";
  id: string;
  planIds: string[];
  sessionCodes: string[];
};
export type FeedbackTaskOpenTarget = {
  planId: string;
  batchId: string;
  semesterId: string;
  classId: string;
  className: string;
  sessionCode: string;
  view?: "intake" | "plan" | "studio";
};

const runningPlanStatuses = new Set(["queued", "generating", "pause_requested"]);
const runningBatchStatuses = new Set(["queued", "running", "pause_requested"]);

export type FeedbackPlanDisplayState = "saved" | "active" | "completed";
const displayStateLabels: Record<FeedbackPlanDisplayState, string> = { saved: "已保存", active: "活动中", completed: "已完成" };
const actionBucketLabels: Record<FeedbackPlanActionBucket, string> = { generating: "正在生成", needs_continue: "需要继续", completed: "最近完成" };

export function feedbackPlanDisplayState(plan: FeedbackPlanSummary): FeedbackPlanDisplayState {
  const progress = plan.itemStatusCounts;
  if (progress.total > 0 && progress.completed === progress.total && progress.queued === 0 && progress.running === 0 && progress.failed === 0) return "completed";
  const started = !["draft", "ready", "evidence_ready"].includes(plan.status)
    || progress.queued + progress.running + progress.completed + progress.failed > 0;
  return started ? "active" : "saved";
}

export function feedbackPlanBatchDisplayState(batch: FeedbackPlanBatchSummary): FeedbackPlanDisplayState {
  const progress = batch.progress;
  if (progress.total > 0 && progress.generated === progress.total && progress.failed === 0 && !runningBatchStatuses.has(batch.status)) return "completed";
  return ["draft", "ready"].includes(batch.status) && progress.generated === 0 ? "saved" : "active";
}

export function shouldPollFeedbackPlanTask(task: FeedbackPlanTaskRow) {
  if (task.kind === "batch") return runningBatchStatuses.has(task.batch.status);
  if (["paused", "generation_failed"].includes(task.plan.status)) return false;
  return runningPlanStatuses.has(task.plan.status)
    || task.plan.itemStatusCounts.queued > 0
    || task.plan.itemStatusCounts.running > 0;
}

export function shouldPollFeedbackPlanTasks(tasks: FeedbackPlanTaskRow[]) {
  return tasks.some(shouldPollFeedbackPlanTask);
}

export function feedbackPlanManagerStatusText(
  tasks: FeedbackPlanTaskRow[],
  currentState: FeedbackPlanDisplayState | null,
) {
  if (currentState) {
    return `${currentState === "completed" ? "已完成反馈生成" : "未完成反馈生成"} · ${tasks.length} 个未归档计划`;
  }
  if (tasks.length === 0) return "尚未建立反馈计划";
  const activeCount = tasks.filter((task) => (
    task.kind === "batch"
      ? feedbackPlanBatchDisplayState(task.batch) === "active"
      : feedbackPlanDisplayState(task.plan) === "active"
  )).length;
  return `${tasks.length} 个未归档计划${activeCount ? ` · ${activeCount} 个活动中` : " · 请选择计划查看"}`;
}

export function feedbackPlanTaskGenerationApproachLabel(task: FeedbackPlanTaskRow) {
  const record = task.kind === "batch" ? task.batch : task.plan;
  if (record.legacyReadonly === true) return record.generationApproachLabel?.trim() || feedbackGenerationApproachLabel(null);
  if (record.generationApproach) return record.generationApproachLabel?.trim() || feedbackGenerationApproachLabel(record.generationApproach);
  return "生成方式未标注";
}

export function feedbackPlanTaskIsCurrent(task: FeedbackPlanTaskRow, currentPlanId?: string, currentBatchId?: string) {
  if (task.kind === "batch") {
    return task.id === currentBatchId || (!currentBatchId && Boolean(currentPlanId) && task.batch.plans.some((plan) => plan.id === currentPlanId));
  }
  return !currentBatchId && task.id === currentPlanId;
}

export function feedbackPlanTaskActionBucket(task: FeedbackPlanTaskRow): FeedbackPlanActionBucket {
  const record = task.kind === "batch" ? task.batch : task.plan;
  if (record.actionBucket === "generating" || record.actionBucket === "needs_continue" || record.actionBucket === "completed") return record.actionBucket;
  if (task.kind === "batch") {
    const counts = task.batch.itemStatusCounts;
    if (counts) return deriveFeedbackPlanActionBucket(task.batch.status, counts, "batch");
    if (["paused", "failed"].includes(task.batch.status)) return "needs_continue";
    if (runningBatchStatuses.has(task.batch.status)) return "generating";
    if (!counts && task.batch.progress.total > 0 && (task.batch.progress.approved === task.batch.progress.total || task.batch.progress.exported === task.batch.progress.total)) return "completed";
    return "needs_continue";
  }
  const counts = task.plan.itemStatusCounts;
  return deriveFeedbackPlanActionBucket(task.plan.status, {
    total: counts.total,
    evidenceReady: counts.evidenceReady ?? 0,
    queued: counts.queued,
    running: counts.running,
    paused: counts.paused ?? 0,
    failed: counts.failed,
    needsReview: counts.needsReview ?? 0,
    approved: counts.approved ?? (task.plan.status === "approved" ? counts.total : 0),
    exported: counts.exported ?? (task.plan.status === "exported" ? counts.total : 0),
    stale: counts.stale ?? 0,
    completed: counts.completed,
  });
}

export function groupFeedbackPlanTasks(tasks: FeedbackPlanTaskRow[], currentPlanId?: string, currentBatchId?: string) {
  const batchChildIds = new Set(tasks.flatMap((task) => task.kind === "batch" ? task.batch.plans.map((plan) => plan.id) : []));
  const uniqueTasks = tasks.filter((task) => task.kind === "batch" || !batchChildIds.has(task.id));
  const current = uniqueTasks.find((task) => feedbackPlanTaskIsCurrent(task, currentPlanId, currentBatchId)) ?? null;
  const sorted = uniqueTasks
    .filter((task) => task !== current)
    .sort((left, right) => {
      const leftUpdated = left.kind === "batch" ? left.batch.updatedAt : left.plan.updatedAt;
      const rightUpdated = right.kind === "batch" ? right.batch.updatedAt : right.plan.updatedAt;
      return (rightUpdated ? Date.parse(rightUpdated) : 0) - (leftUpdated ? Date.parse(leftUpdated) : 0);
    });
  return {
    current,
    generating: sorted.filter((task) => feedbackPlanTaskActionBucket(task) === "generating"),
    needsContinue: sorted.filter((task) => feedbackPlanTaskActionBucket(task) === "needs_continue"),
    completed: sorted.filter((task) => feedbackPlanTaskActionBucket(task) === "completed").slice(0, 5),
  };
}

export function feedbackPlanTaskPrimaryActionLabel(task: FeedbackPlanTaskRow) {
  const record = task.kind === "batch" ? task.batch : task.plan;
  if (record.legacyReadonly === true) return "复核已有正文";
  const bucket = feedbackPlanTaskActionBucket(task);
  if (bucket === "generating") return "查看生成";
  if (bucket === "completed") return "查看结果";
  if (["draft", "ready", "evidence_ready"].includes(record.status)) return "继续规划";
  return "继续复核";
}

function typeLabel(type: string) {
  return ({ class_update: "班级公共反馈", event_micro: "事件型微反馈", stage_trend: "阶段趋势反馈", course_end: "结课教学总结" } as Record<string, string>)[type] ?? type;
}

function planOpenTarget(plan: FeedbackPlanSummary): FeedbackTaskOpenTarget {
  const session = plan.type === "stage_trend" || plan.type === "course_end" ? plan.rangeEndSession : plan.session;
  return {
    planId: plan.id,
    batchId: "",
    semesterId: plan.semester?.id ?? "",
    classId: plan.class?.id ?? "",
    className: plan.class?.name ?? plan.class?.code ?? "",
    sessionCode: session?.code ?? "",
    view: ["draft", "ready", "evidence_ready"].includes(plan.status) ? "plan" : "studio",
  };
}

function batchOpenTarget(batch: FeedbackPlanBatchSummary): FeedbackTaskOpenTarget {
  const first = batch.plans[0];
  return {
    planId: first?.id ?? "",
    batchId: batch.id,
    semesterId: batch.semester?.id ?? "",
    classId: first?.class.id ?? "",
    className: first?.class.name ?? first?.class.code ?? "",
    sessionCode: first?.session?.code ?? first?.rangeEndSession?.code ?? "",
    view: batch.status === "draft" || batch.status === "ready" ? "plan" : "studio",
  };
}

function taskHref(target: FeedbackTaskOpenTarget) {
  const params = new URLSearchParams();
  params.set("view", target.view ?? "studio");
  if (target.planId) params.set("planId", target.planId);
  if (target.batchId) params.set("batchId", target.batchId);
  if (target.semesterId) params.set("semesterId", target.semesterId);
  if (target.classId) params.set("classId", target.classId);
  if (target.className) params.set("class", target.className);
  if (target.sessionCode) params.set("sessionCode", target.sessionCode);
  return `/feedback?${params.toString()}`;
}

async function waitUntilStopped(kind: "plan" | "batch", id: string, running: Set<string>) {
  const path = kind === "batch" ? "feedback-plan-batches" : "feedback-plans";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const current = await requestJson<Record<string, { status: string }>>(`/api/report/${path}/${encodeURIComponent(id)}`);
    if (!running.has(current[kind].status)) return;
  }
  throw new Error("计划仍在停止中，请稍后再归档");
}

export default function FeedbackPlanManager({ semesterId, currentPlanId, currentBatchId, refreshKey = 0, onOpen, onArchived }: {
  semesterId?: string;
  currentPlanId?: string;
  currentBatchId?: string;
  refreshKey?: number;
  onOpen?: (target: FeedbackTaskOpenTarget) => void;
  onArchived?: (reference: ArchivedFeedbackTaskReference) => void;
}) {
  const [plans, setPlans] = useState<FeedbackPlanSummary[]>([]);
  const [batches, setBatches] = useState<FeedbackPlanBatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nameSearch, setNameSearch] = useState("");
  const [classSearch, setClassSearch] = useState("");
  const loadSequence = useRef(0);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const sequence = ++loadSequence.current;
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const query = new URLSearchParams({ archived: "false" });
      if (semesterId) query.set("semesterId", semesterId);
      const [planResult, batchResult] = await Promise.all([
        requestJson<{ plans: FeedbackPlanSummary[] }>(`/api/report/feedback-plans?${query}`),
        requestJson<{ batches: FeedbackPlanBatchSummary[] }>(`/api/report/feedback-plan-batches?${query}`),
      ]);
      if (sequence !== loadSequence.current) return;
      setPlans(planResult.plans.filter((plan) => !plan.archivedAt));
      setBatches(batchResult.batches.filter((batch) => !batch.archivedAt));
    } catch (reason) {
      if (sequence === loadSequence.current && !silent) setError(reason instanceof Error ? reason.message : "读取当前反馈计划失败");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [semesterId]);

  useEffect(() => { void load(); }, [currentBatchId, currentPlanId, load, refreshKey]);

  const tasks = useMemo<FeedbackPlanTaskRow[]>(() => {
    const childIds = new Set(batches.flatMap((batch) => batch.plans.map((plan) => plan.id)));
    return [
      ...batches.map((batch) => ({ kind: "batch" as const, id: batch.id, batch })),
      ...plans.filter((plan) => !plan.batchId && !childIds.has(plan.id)).map((plan) => ({ kind: "plan" as const, id: plan.id, plan })),
    ];
  }, [batches, plans]);
  const semesterTasks = useMemo(() => tasks.filter((task) => {
    if (!semesterId) return true;
    const taskSemesterId = task.kind === "batch" ? task.batch.semester?.id : task.plan.semester?.id;
    return !taskSemesterId || taskSemesterId === semesterId;
  }), [semesterId, tasks]);
  const groupedTasks = useMemo(() => groupFeedbackPlanTasks(semesterTasks, currentPlanId, currentBatchId), [currentBatchId, currentPlanId, semesterTasks]);
  const currentTask = groupedTasks.current;
  const currentState = currentTask ? (currentTask.kind === "batch" ? feedbackPlanBatchDisplayState(currentTask.batch) : feedbackPlanDisplayState(currentTask.plan)) : null;
  const shouldPollTasks = shouldPollFeedbackPlanTasks(semesterTasks);

  useEffect(() => {
    if (!shouldPollTasks || loading) return;
    const timer = window.setInterval(() => void load({ silent: true }), 1000);
    return () => window.clearInterval(timer);
  }, [load, loading, shouldPollTasks]);

  async function archiveTask(task: FeedbackPlanTaskRow) {
    const label = task.kind === "batch" ? task.batch.displayName ?? `班级组反馈（${task.batch.plans.length} 个班级）` : task.plan.displayName ?? `${typeLabel(task.plan.type)} · ${task.plan.class?.name ?? task.plan.class?.code ?? "当前班级"}`;
    if (!window.confirm(`归档“${label}”吗？\n已生成正文、课堂事实和导出历史都会保留；归档后同一材料可建立新计划。`)) return;
    setBusyId(task.id); setError(""); setNotice("");
    try {
      if (task.kind === "batch") {
        if (runningBatchStatuses.has(task.batch.status)) {
          await requestJson(`/api/report/feedback-plan-batches/${encodeURIComponent(task.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pause" }) });
          await waitUntilStopped("batch", task.id, runningBatchStatuses);
        }
        await requestJson(`/api/report/feedback-plan-batches/${encodeURIComponent(task.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive" }) });
      } else {
        if (runningPlanStatuses.has(task.plan.status)) {
          await requestJson(`/api/report/feedback-plans/${encodeURIComponent(task.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pause_generation" }) });
          await waitUntilStopped("plan", task.id, runningPlanStatuses);
        }
        await requestJson(`/api/report/feedback-plans/${encodeURIComponent(task.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive" }) });
      }
      onArchived?.({
        kind: task.kind,
        id: task.id,
        planIds: task.kind === "batch" ? task.batch.plans.map((plan) => plan.id) : [task.plan.id],
        sessionCodes: task.kind === "batch"
          ? task.batch.plans.flatMap((plan) => {
              const sessionCode = plan.session?.code ?? plan.rangeEndSession?.code;
              return sessionCode ? [sessionCode] : [];
            })
          : task.plan.session?.code || task.plan.rangeEndSession?.code
            ? [task.plan.session?.code ?? task.plan.rangeEndSession!.code]
            : [],
      });
      setNotice("反馈计划已归档；现在可以使用相同材料建立另一份计划。");
      setDrawerOpen(false);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "归档反馈计划失败"); }
    finally { setBusyId(""); }
  }

  function taskTitle(task: FeedbackPlanTaskRow) {
    return task.kind === "batch"
      ? task.batch.displayName ?? `班级组反馈 · ${task.batch.plans.length} 个班级`
      : task.plan.displayName ?? typeLabel(task.plan.type);
  }

  function taskClassText(task: FeedbackPlanTaskRow) {
    if (task.kind === "batch") return task.batch.plans.map((plan) => plan.class.name ?? plan.class.code).join("、") || "班级组";
    return task.plan.class?.name ?? task.plan.class?.code ?? "未绑定班级";
  }

  function taskSessionText(task: FeedbackPlanTaskRow) {
    if (task.kind === "batch") {
      const codes = [...new Set(task.batch.plans.map((plan) => plan.session?.code ?? plan.rangeEndSession?.code).filter(Boolean))];
      return codes.join("、") || "课次待确认";
    }
    return task.plan.session?.code ?? task.plan.rangeEndSession?.code ?? "课次待确认";
  }

  function taskDescription(task: FeedbackPlanTaskRow) {
    if (task.kind === "batch") {
      const counts = task.batch.itemStatusCounts;
      const awaitingReview = counts?.needsReview ?? Math.max(0, task.batch.progress.generated - task.batch.progress.approved);
      const approved = counts?.approved ?? Math.max(0, task.batch.progress.approved - task.batch.progress.exported);
      const exported = counts?.exported ?? task.batch.progress.exported;
      return `${typeLabel(task.batch.type)} · ${feedbackPlanTaskGenerationApproachLabel(task)} · 生成 ${task.batch.progress.generated}/${task.batch.progress.total} · 待复核 ${awaitingReview} · 已批准 ${approved} · 已导出 ${exported}`;
    }
    const counts = task.plan.itemStatusCounts;
    return `${typeLabel(task.plan.type)} · ${feedbackPlanTaskGenerationApproachLabel(task)} · 生成 ${counts.completed}/${counts.total} · 排队/生成 ${counts.queued + counts.running} · 失败 ${counts.failed} · 待复核 ${counts.needsReview ?? Math.max(0, counts.completed - (counts.approved ?? 0) - (counts.exported ?? 0))} · 已批准 ${counts.approved ?? 0} · 已导出 ${counts.exported ?? 0}`;
  }

  function openTask(task: FeedbackPlanTaskRow) {
    const target = task.kind === "batch" ? batchOpenTarget(task.batch) : planOpenTarget(task.plan);
    setDrawerOpen(false);
    onOpen?.(target);
  }

  function renderTask(task: FeedbackPlanTaskRow, pinned = false) {
    const isBatch = task.kind === "batch";
    const record = isBatch ? task.batch : task.plan;
    const displayState = isBatch ? feedbackPlanBatchDisplayState(task.batch) : feedbackPlanDisplayState(task.plan);
    const openTarget = isBatch ? batchOpenTarget(task.batch) : planOpenTarget(task.plan);
    const isLegacy = record.legacyReadonly === true;
    return <article key={`${task.kind}:${task.id}`} className={`${styles.row} ${pinned ? styles.current : ""}`}>
      <div className={styles.meta}>
        <div className={styles.title}><strong>{taskTitle(task)}</strong><Badge tone={displayState === "completed" ? "success" : displayState === "active" ? "warning" : "info"}>{displayStateLabels[displayState]}</Badge>{isBatch && <Badge tone="neutral">班级组</Badge>}{isLegacy && <Badge tone="warning">旧生成只读</Badge>}</div>
        <span>{taskClassText(task)} · {taskSessionText(task)}</span>
        <small>{taskDescription(task)}</small>
      </div>
      <div className={styles.actions}>{onOpen
        ? <Button uiSize="sm" onClick={() => openTask(task)} disabled={Boolean(busyId)}>{pinned ? feedbackPlanTaskPrimaryActionLabel(task) : "打开"}</Button>
        : <Link className="ui-button ui-button--primary ui-button--sm" href={taskHref(openTarget)} onClick={() => setDrawerOpen(false)}>{pinned ? feedbackPlanTaskPrimaryActionLabel(task) : "打开"}</Link>}
        <Button uiSize="sm" variant="ghost" onClick={() => void archiveTask(task)} disabled={Boolean(busyId)}>{busyId === task.id ? "归档中…" : "归档"}</Button>
      </div>
    </article>;
  }

  const normalizedNameSearch = nameSearch.trim().toLocaleLowerCase("zh-CN");
  const normalizedClassSearch = classSearch.trim().toLocaleLowerCase("zh-CN");
  const matchesSearch = (task: FeedbackPlanTaskRow) => (
    (!normalizedNameSearch || taskTitle(task).toLocaleLowerCase("zh-CN").includes(normalizedNameSearch))
    && (!normalizedClassSearch || taskClassText(task).toLocaleLowerCase("zh-CN").includes(normalizedClassSearch))
  );
  const searchedGroups = groupFeedbackPlanTasks(semesterTasks.filter(matchesSearch), currentPlanId, currentBatchId);
  const visibleGenerating = searchedGroups.generating;
  const visibleNeedsContinue = searchedGroups.needsContinue;
  const visibleCompleted = searchedGroups.completed;
  const currentTarget = currentTask ? (currentTask.kind === "batch" ? batchOpenTarget(currentTask.batch) : planOpenTarget(currentTask.plan)) : null;
  const currentRecord = currentTask ? (currentTask.kind === "batch" ? currentTask.batch : currentTask.plan) : null;

  return <section className={styles.panel} aria-label="反馈计划选择器">
    <div className={styles.currentBar}>
      <div className={styles.currentSummary}>
        <span className={styles.eyebrow}>当前计划</span>
        {currentTask ? <><div className={styles.currentTitle}><strong>{taskTitle(currentTask)}</strong><Badge tone={currentState === "completed" ? "success" : currentState === "active" ? "warning" : "info"}>{currentState ? displayStateLabels[currentState] : "当前"}</Badge>{currentTask.kind === "batch" && <Badge tone="neutral">班级组</Badge>}{currentRecord?.legacyReadonly === true && <Badge tone="warning">旧生成只读</Badge>}</div><span>{taskClassText(currentTask)} · {taskSessionText(currentTask)} · {feedbackPlanTaskGenerationApproachLabel(currentTask)}</span><small>{taskDescription(currentTask)}</small></> : <><strong>尚未选择计划</strong><span>{loading ? "正在读取当前学期计划…" : feedbackPlanManagerStatusText(semesterTasks, null)}</span></>}
      </div>
      <div className={styles.currentActions}>{currentTask && currentTarget && (onOpen
        ? <Button onClick={() => onOpen(currentTarget)} disabled={Boolean(busyId)}>{feedbackPlanTaskPrimaryActionLabel(currentTask)}</Button>
        : <Link className="ui-button ui-button--primary" href={taskHref(currentTarget)}>{feedbackPlanTaskPrimaryActionLabel(currentTask)}</Link>)}<Button variant="secondary" onClick={() => setDrawerOpen(true)} disabled={loading}>{currentTask ? "切换计划" : "选择计划"}</Button></div>
    </div>
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {notice && <StatusBanner tone="success">{notice}</StatusBanner>}
    <Drawer open={drawerOpen} title="切换反馈计划" onClose={() => setDrawerOpen(false)} size="wide">
      <div className={styles.drawerBody}>
        <div className={styles.searches}><label>计划名称<input type="search" value={nameSearch} onChange={(event) => setNameSearch(event.target.value)} placeholder="搜索计划名称" /></label><label>班级<input type="search" value={classSearch} onChange={(event) => setClassSearch(event.target.value)} placeholder="搜索班级" /></label></div>
        <div className={styles.drawerMeta}><span>默认仅显示当前学期；班级组始终只占一行。</span><Button uiSize="sm" variant="ghost" onClick={() => void load()} disabled={loading || Boolean(busyId)}>刷新</Button></div>
        {currentTask && <section className={styles.group}><h3>当前计划</h3>{renderTask(currentTask, true)}</section>}
        {visibleGenerating.length > 0 && <section className={styles.group}><h3>{actionBucketLabels.generating} · {visibleGenerating.length}</h3>{visibleGenerating.map((task) => renderTask(task))}</section>}
        {visibleNeedsContinue.length > 0 && <section className={styles.group}><h3>{actionBucketLabels.needs_continue} · {visibleNeedsContinue.length}</h3>{visibleNeedsContinue.map((task) => renderTask(task))}</section>}
        {visibleCompleted.length > 0 && <details className={styles.completedGroup}><summary>{actionBucketLabels.completed} · {visibleCompleted.length}<span>最近 5 项</span></summary><div>{visibleCompleted.map((task) => renderTask(task))}</div></details>}
        {!loading && !currentTask && visibleGenerating.length === 0 && visibleNeedsContinue.length === 0 && visibleCompleted.length === 0 && <p className={styles.empty}>当前筛选下没有反馈计划。</p>}
        <Link className={styles.historyLink} href={`/history?${new URLSearchParams(semesterId ? { semesterId } : {}).toString()}`} onClick={() => setDrawerOpen(false)}>查看完整反馈历史</Link>
      </div>
    </Drawer>
  </section>;
}
