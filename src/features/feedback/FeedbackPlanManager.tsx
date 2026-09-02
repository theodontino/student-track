"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import styles from "./feedback-plan-manager.module.css";

type PlanSummary = {
  id: string; type: string; status: string; archivedAt?: string | null; batchId?: string | null;
  session?: { code: string } | null; rangeEndSession?: { code: string } | null;
  class?: { id: string; code: string; name?: string | null } | null;
  semester?: { id: string; name: string } | null;
  itemStatusCounts: { total: number; queued: number; running: number; completed: number; failed: number };
};

type BatchSummary = {
  id: string; status: string; archivedAt?: string | null; semester?: { id: string; name: string } | null;
  plans: Array<{ id: string; class: { id: string; code: string; name?: string | null }; session?: { code: string } | null }>;
  progress: { total: number; generated: number; approved: number; exported: number; failed: number; completedClasses: number; totalClasses: number };
};

type TaskRow = { kind: "plan"; id: string; plan: PlanSummary } | { kind: "batch"; id: string; batch: BatchSummary };
export type ArchivedFeedbackTaskReference = {
  kind: "plan" | "batch";
  id: string;
  planIds: string[];
  sessionCodes: string[];
};

const statusLabels: Record<string, string> = {
  draft: "草稿", evidence_ready: "证据就绪", queued: "排队中", generating: "生成中", running: "生成中",
  pause_requested: "暂停中", paused: "已暂停", generation_failed: "生成失败", failed: "生成失败",
  ready: "准备就绪", in_review: "待复核", needs_review: "待教师批准", partially_approved: "部分批准",
  approved: "已批准", partially_exported: "部分已导出", exported: "已导出", stale: "证据已变化",
  completed: "生成完成", archived: "已归档",
};
const runningPlanStatuses = new Set(["queued", "generating", "pause_requested"]);
const runningBatchStatuses = new Set(["queued", "running", "pause_requested"]);

function typeLabel(type: string) {
  return ({ class_update: "班级公共反馈", event_micro: "事件型微反馈", stage_trend: "阶段趋势反馈", course_end: "结课教学总结" } as Record<string, string>)[type] ?? type;
}

function planHref(plan: PlanSummary) {
  const session = plan.type === "stage_trend" || plan.type === "course_end" ? plan.rangeEndSession : plan.session;
  const params = new URLSearchParams({ planId: plan.id });
  if (plan.semester?.id) params.set("semesterId", plan.semester.id);
  if (plan.class?.name || plan.class?.code) params.set("class", plan.class.name ?? plan.class.code);
  if (session?.code) params.set("sessionCode", session.code);
  return `/feedback?${params.toString()}`;
}

function batchHref(batch: BatchSummary) {
  const first = batch.plans[0];
  const params = new URLSearchParams({ batchId: batch.id });
  if (first?.id) params.set("planId", first.id);
  if (batch.semester?.id) params.set("semesterId", batch.semester.id);
  if (first?.class?.name || first?.class?.code) params.set("class", first.class.name ?? first.class.code);
  if (first?.session?.code) params.set("sessionCode", first.session.code);
  return `/feedback?${params.toString()}`;
}

async function waitUntilStopped(kind: "plan" | "batch", id: string, running: Set<string>) {
  const path = kind === "batch" ? "feedback-plan-batches" : "feedback-plans";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    const current = await requestJson<Record<string, { status: string }>>(`/api/report/${path}/${encodeURIComponent(id)}`);
    if (!running.has(current[kind].status)) return;
  }
  throw new Error("任务仍在停止中，请稍后再归档");
}

export default function FeedbackPlanManager({ semesterId, onArchived }: {
  semesterId?: string;
  onArchived?: (reference: ArchivedFeedbackTaskReference) => void;
}) {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ archived: "false" });
      if (semesterId) query.set("semesterId", semesterId);
      const [planResult, batchResult] = await Promise.all([
        requestJson<{ plans: PlanSummary[] }>(`/api/report/feedback-plans?${query}`),
        requestJson<{ batches: BatchSummary[] }>(`/api/report/feedback-plan-batches?${query}`),
      ]);
      setPlans(planResult.plans.filter((plan) => !plan.archivedAt));
      setBatches(batchResult.batches.filter((batch) => !batch.archivedAt));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取当前反馈任务失败"); }
    finally { setLoading(false); }
  }, [semesterId]);

  useEffect(() => { void load(); }, [load]);

  const tasks = useMemo<TaskRow[]>(() => {
    const childIds = new Set(batches.flatMap((batch) => batch.plans.map((plan) => plan.id)));
    return [
      ...batches.map((batch) => ({ kind: "batch" as const, id: batch.id, batch })),
      ...plans.filter((plan) => !plan.batchId && !childIds.has(plan.id)).map((plan) => ({ kind: "plan" as const, id: plan.id, plan })),
    ];
  }, [batches, plans]);

  async function archiveTask(task: TaskRow) {
    const label = task.kind === "batch" ? `班级组反馈（${task.batch.plans.length} 个班级）` : `${typeLabel(task.plan.type)} · ${task.plan.class?.name ?? task.plan.class?.code ?? "当前班级"}`;
    if (!window.confirm(`归档“${label}”吗？\n已生成正文、课堂事实和导出历史都会保留；归档后同一材料可建立新任务。`)) return;
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
          ? task.batch.plans.flatMap((plan) => plan.session?.code ? [plan.session.code] : [])
          : task.plan.session?.code ? [task.plan.session.code] : [],
      });
      setNotice("反馈任务已归档；现在可以使用相同材料重新建立任务。");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "归档反馈任务失败"); }
    finally { setBusyId(""); }
  }

  return <section className={styles.panel} aria-label="当前反馈任务">
    <header className={styles.header}>
      <div><strong>当前反馈任务</strong><span>{loading ? "正在读取…" : `${tasks.length} 个未归档任务`}</span></div>
      <Button uiSize="sm" variant="ghost" onClick={() => void load()} disabled={loading || Boolean(busyId)}>刷新</Button>
    </header>
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {notice && <StatusBanner tone="success">{notice}</StatusBanner>}
    {!loading && tasks.length === 0 ? <p className={styles.empty}>当前没有未归档反馈任务。历史任务可在<Link href="/history?archived=true">反馈历史</Link>中查看。</p> : <div className={styles.list}>
      {tasks.map((task) => {
        const isBatch = task.kind === "batch";
        const status = isBatch ? task.batch.status : task.plan.status;
        const href = isBatch ? batchHref(task.batch) : planHref(task.plan);
        const title = isBatch ? `班级组反馈 · ${task.batch.plans.length} 个班级` : typeLabel(task.plan.type);
        const description = isBatch ? `${task.batch.progress.completedClasses}/${task.batch.progress.totalClasses} 班生成完成 · ${task.batch.progress.approved} 条已批准` : `${task.plan.class?.name ?? task.plan.class?.code ?? "未绑定班级"} · ${task.plan.itemStatusCounts.completed}/${task.plan.itemStatusCounts.total} 条生成完成`;
        return <article key={`${task.kind}:${task.id}`} className={styles.row}>
          <div className={styles.meta}><div className={styles.title}><strong>{title}</strong><Badge tone={(isBatch ? runningBatchStatuses : runningPlanStatuses).has(status) ? "warning" : "info"}>{statusLabels[status] ?? status}</Badge></div><span>{description}</span></div>
          <div className={styles.actions}><Link className="ui-button ui-button--ghost ui-button--sm" href={href}>打开</Link><Button uiSize="sm" variant="secondary" onClick={() => void archiveTask(task)} disabled={Boolean(busyId)}>{busyId === task.id ? "归档中…" : "归档"}</Button></div>
        </article>;
      })}
    </div>}
  </section>;
}
