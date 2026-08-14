"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import styles from "./feedback-plan-manager.module.css";

type PlanSummary = {
  id: string;
  type: string;
  status: string;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  outputRequirement: string;
  batchId?: string | null;
  session?: { code: string; date: string; semesterNumber: number } | null;
  rangeEndSession?: { code: string; date: string; semesterNumber: number } | null;
  class?: { id: string; code: string; name?: string | null } | null;
  semester?: { id: string; name: string } | null;
  itemStatusCounts: { total: number; queued: number; running: number; completed: number; failed: number };
};

const statusLabels: Record<string, string> = {
  draft: "草稿",
  evidence_ready: "证据就绪",
  queued: "排队中",
  generating: "生成中",
  pause_requested: "暂停中",
  paused: "已暂停",
  generation_failed: "有失败",
  in_review: "待复核",
  partially_approved: "部分批准",
};

const runningStatuses = new Set(["queued", "generating", "pause_requested"]);
const manageableStatuses = new Set(["draft", "evidence_ready", "queued", "generating", "pause_requested", "paused", "generation_failed"]);

function typeLabel(type: string) {
  return ({ class_update: "班级公共反馈", event_micro: "事件型微反馈", stage_trend: "阶段趋势反馈", course_end: "结课教学总结" } as Record<string, string>)[type] ?? type;
}

function restoreHref(plan: PlanSummary) {
  const step = runningStatuses.has(plan.status)
    ? "generate"
    : ["draft", "evidence_ready", "generation_failed"].includes(plan.status) ? "review" : "export";
  const session = (plan.type === "stage_trend" || plan.type === "course_end" ? plan.rangeEndSession : plan.session);
  const params = new URLSearchParams({ step, planId: plan.id });
  if (plan.semester?.id) params.set("semesterId", plan.semester.id);
  if (plan.class?.id) params.set("classId", plan.class.id);
  if (plan.class?.name || plan.class?.code) params.set("class", plan.class.name ?? plan.class.code);
  if (session?.code) params.set("sessionCode", session.code);
  return `/feedback?${params.toString()}`;
}

function progressLabel(plan: PlanSummary) {
  const counts = plan.itemStatusCounts;
  return `${counts.completed}/${counts.total} 完成 · ${counts.running} 进行中 · ${counts.queued} 排队`;
}

export default function FeedbackPlanManager({ semesterId }: { semesterId?: string }) {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ archived: "false" });
      if (semesterId) query.set("semesterId", semesterId);
      const result = await requestJson<{ plans: PlanSummary[] }>(`/api/report/feedback-plans?${query}`);
      setPlans(result.plans.filter((plan) => !plan.archivedAt && manageableStatuses.has(plan.status)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取进行中计划失败");
    } finally {
      setLoading(false);
    }
  }, [semesterId]);

  useEffect(() => { void load(); }, [load]);

  const visiblePlans = useMemo(() => plans.slice(0, 12), [plans]);

  async function clearPlan(plan: PlanSummary) {
    if (!window.confirm(`清理“${typeLabel(plan.type)} · ${plan.class?.name ?? plan.class?.code ?? "当前班级"}”吗？\n生成中的计划会先暂停；已生成内容会归档，之后仍可从反馈历史恢复。`)) return;
    setBusyId(plan.id);
    setError("");
    setNotice("");
    try {
      let status = plan.status;
      if (runningStatuses.has(status)) {
        await requestJson(`/api/report/feedback-plans/${encodeURIComponent(plan.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "pause_generation" }),
        });
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          const current = await requestJson<{ plan: { status: string } }>(`/api/report/feedback-plans/${encodeURIComponent(plan.id)}`);
          status = current.plan.status;
          if (!runningStatuses.has(status)) break;
        }
        if (runningStatuses.has(status)) throw new Error("计划仍在停止中，请稍后再清理一次");
      }

      if (["draft", "evidence_ready"].includes(status)) {
        await requestJson(`/api/report/feedback-plans/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
        setNotice("反馈计划已删除。");
      } else {
        await requestJson(`/api/report/feedback-plans/${encodeURIComponent(plan.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "archive" }),
        });
        setNotice("反馈计划已归档；生成结果和课堂事实仍保留在反馈历史中。");
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "清理反馈计划失败");
    } finally {
      setBusyId("");
    }
  }

  return <section className={styles.panel} aria-label="进行中的反馈计划">
    <header className={styles.header}>
      <div><strong>进行中的反馈计划</strong><span>{loading ? "正在读取…" : `${plans.length} 个计划`}</span></div>
      <Button uiSize="sm" variant="ghost" onClick={() => void load()} disabled={loading || Boolean(busyId)}>刷新</Button>
    </header>
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {notice && <StatusBanner tone="success">{notice}</StatusBanner>}
    {!loading && visiblePlans.length === 0 ? <p className={styles.empty}>当前没有正在生成或等待处理的计划。已完成、待复核或已归档计划可在<a href="/history?archived=false">反馈历史</a>中恢复。</p> : <div className={styles.list}>
      {visiblePlans.map((plan) => {
        const session = (plan.type === "stage_trend" || plan.type === "course_end" ? plan.rangeEndSession : plan.session);
        const isBusy = busyId === plan.id;
        return <article key={plan.id} className={styles.row}>
          <div className={styles.meta}>
            <div className={styles.title}><strong>{typeLabel(plan.type)}</strong><Badge tone={runningStatuses.has(plan.status) ? "warning" : "info"}>{statusLabels[plan.status] ?? plan.status}</Badge></div>
            <span>{plan.class?.name ?? plan.class?.code ?? "未绑定班级"} · {session?.code ?? "阶段计划"} · {progressLabel(plan)}</span>
          </div>
          <div className={styles.actions}>
            <Link className="ui-button ui-button--ghost ui-button--sm" href={restoreHref(plan)}>打开</Link>
            <Button uiSize="sm" variant="secondary" onClick={() => void clearPlan(plan)} disabled={Boolean(busyId)}>{isBusy ? "清理中…" : ["draft", "evidence_ready"].includes(plan.status) ? "删除" : "清理/归档"}</Button>
          </div>
        </article>;
      })}
    </div>}
    {plans.length > visiblePlans.length && <Link className={styles.more} href="/history?archived=false">查看全部当前计划 →</Link>}
  </section>;
}
