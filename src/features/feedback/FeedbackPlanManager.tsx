"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import styles from "./feedback-plan-manager.module.css";

export type FeedbackPlanSummary = {
  id: string; displayName?: string | null; type: string; status: string; archivedAt?: string | null; batchId?: string | null;
  session?: { code: string } | null; rangeEndSession?: { code: string } | null;
  class?: { id: string; code: string; name?: string | null } | null;
  semester?: { id: string; name: string } | null;
  itemStatusCounts: { total: number; queued: number; running: number; completed: number; failed: number };
};

export type FeedbackPlanBatchSummary = {
  id: string; displayName?: string | null; type: string; status: string; archivedAt?: string | null; semester?: { id: string; name: string } | null;
  plans: Array<{ id: string; class: { id: string; code: string; name?: string | null }; session?: { code: string } | null; rangeEndSession?: { code: string } | null }>;
  progress: { total: number; generated: number; approved: number; exported: number; failed: number; completedClasses: number; totalClasses: number };
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

export default function FeedbackPlanManager({ currentPlanId, currentBatchId, refreshKey = 0, onOpen, onArchived }: {
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
  const loadSequence = useRef(0);

  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const sequence = ++loadSequence.current;
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const query = new URLSearchParams({ archived: "false" });
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
  }, []);

  useEffect(() => { void load(); }, [currentBatchId, currentPlanId, load, refreshKey]);

  const tasks = useMemo<FeedbackPlanTaskRow[]>(() => {
    const childIds = new Set(batches.flatMap((batch) => batch.plans.map((plan) => plan.id)));
    return [
      ...batches.map((batch) => ({ kind: "batch" as const, id: batch.id, batch })),
      ...plans.filter((plan) => !plan.batchId && !childIds.has(plan.id)).map((plan) => ({ kind: "plan" as const, id: plan.id, plan })),
    ];
  }, [batches, plans]);
  const groups = useMemo(() => {
    const bySemester = new Map<string, { name: string; tasks: FeedbackPlanTaskRow[] }>();
    for (const task of tasks) {
      const semester = task.kind === "batch" ? task.batch.semester : task.plan.semester;
      const key = semester?.id ?? "unknown";
      const group = bySemester.get(key) ?? { name: semester?.name ?? "未命名学期", tasks: [] };
      group.tasks.push(task);
      bySemester.set(key, group);
    }
    return [...bySemester.values()];
  }, [tasks]);
  const currentTask = tasks.find((task) => task.kind === "batch" ? task.id === currentBatchId : !currentBatchId && task.id === currentPlanId);
  const currentState = currentTask ? (currentTask.kind === "batch" ? feedbackPlanBatchDisplayState(currentTask.batch) : feedbackPlanDisplayState(currentTask.plan)) : null;
  const shouldPollTasks = shouldPollFeedbackPlanTasks(tasks);

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
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "归档反馈计划失败"); }
    finally { setBusyId(""); }
  }

  return <section className={styles.panel} aria-label="反馈计划选择器">
    <header className={styles.header}>
      <div><strong>反馈计划</strong><span>{loading ? "正在读取…" : feedbackPlanManagerStatusText(tasks, currentState)}</span></div>
      <Button uiSize="sm" variant="ghost" onClick={() => void load()} disabled={loading || Boolean(busyId)}>刷新</Button>
    </header>
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {notice && <StatusBanner tone="success">{notice}</StatusBanner>}
    {!loading && tasks.length === 0 ? <p className={styles.empty}>尚未建立反馈计划。历史计划可在<Link href="/history?archived=true">反馈历史</Link>中查看。</p> : <div className={styles.list}>
      {groups.map((group) => <section className={styles.group} key={group.name}><h3>{group.name}</h3>{group.tasks.map((task) => {
        const isBatch = task.kind === "batch";
        const displayState = isBatch ? feedbackPlanBatchDisplayState(task.batch) : feedbackPlanDisplayState(task.plan);
        const isCurrent = isBatch ? task.id === currentBatchId : !currentBatchId && task.id === currentPlanId;
        const openTarget = isBatch ? batchOpenTarget(task.batch) : planOpenTarget(task.plan);
        const href = taskHref(openTarget);
        const title = isBatch ? task.batch.displayName ?? `班级组反馈 · ${task.batch.plans.length} 个班级` : task.plan.displayName ?? typeLabel(task.plan.type);
        const description = isBatch
          ? `${typeLabel(task.batch.type)} · ${task.batch.progress.completedClasses}/${task.batch.progress.totalClasses} 班生成完成 · ${task.batch.progress.approved} 条已批准`
          : `${typeLabel(task.plan.type)} · ${task.plan.class?.name ?? task.plan.class?.code ?? "未绑定班级"} · ${task.plan.itemStatusCounts.completed}/${task.plan.itemStatusCounts.total} 条生成完成`;
        return <article key={`${task.kind}:${task.id}`} className={`${styles.row} ${isCurrent ? styles.current : ""}`}>
          <div className={styles.meta}><div className={styles.title}><strong>{title}</strong><Badge tone={displayState === "completed" ? "success" : displayState === "active" ? "warning" : "info"}>{displayStateLabels[displayState]}</Badge>{isCurrent && <Badge tone="info">当前打开</Badge>}</div><span>{description} · 批准、导出进度分别保留</span></div>
          <div className={styles.actions}>{onOpen ? <Button uiSize="sm" variant="ghost" onClick={() => onOpen(openTarget)} disabled={Boolean(busyId)}>打开</Button> : <Link className="ui-button ui-button--ghost ui-button--sm" href={href}>打开</Link>}<Button uiSize="sm" variant="secondary" onClick={() => void archiveTask(task)} disabled={Boolean(busyId)}>{busyId === task.id ? "归档中…" : "归档"}</Button></div>
        </article>;
      })}</section>)}
    </div>}
  </section>;
}
