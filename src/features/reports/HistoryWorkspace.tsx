"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageHeader, SegmentedControl } from "@/components/ui";
import { AiWorkflowStatus, useAiWorkflow } from "@/features/ai-workflow";
import { ReviewStep } from "@/features/entry";
import { requestJson } from "@/lib/api-client";
import type { HistoryModule, WorkHistory } from "@/lib/history";
import { GenerationHistoryPanel } from "./GenerationHistoryPanel";

const MODULES: Array<{ value: HistoryModule; label: string }> = [
  { value: "feedback", label: "课后反馈" }, { value: "quick-score", label: "手动评分" },
  { value: "input", label: "课堂录入" }, { value: "report", label: "报告" }, { value: "export", label: "导出" },
];

export default function HistoryWorkspace({ initialView = "history" }: { initialView?: "history" | "drafts" | "ai" }) {
  const [view, setView] = useState<"history" | "drafts" | "ai">(initialView);
  const [module, setModule] = useState<HistoryModule>("feedback");
  const [items, setItems] = useState<WorkHistory<unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const reviewWorkflow = useAiWorkflow();

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setItems(await requestJson<WorkHistory<unknown>[]>(`/api/history?module=${encodeURIComponent(module)}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "加载历史失败"); }
    finally { setLoading(false); }
  }, [module]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "drafts") url.searchParams.set("view", "drafts");
    else if (view === "ai") url.searchParams.set("view", "ai");
    else url.searchParams.delete("view");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, [view]);

  async function confirmDelete() {
    setClearing(true); setError("");
    try {
      if (deleteId) { await requestJson<{ success: true }>(`/api/history?id=${encodeURIComponent(deleteId)}`, { method: "DELETE" }); setItems((current) => current.filter((item) => item.id !== deleteId)); }
      else { await requestJson<{ success: true }>(`/api/history?module=${encodeURIComponent(module)}`, { method: "DELETE" }); setItems([]); }
      setDeleteId(null); setClearing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除历史失败"); }
    finally { setClearing(false); }
  }

  return <main className="history-workspace">
    <PageHeader title="工作历史" description={view === "drafts" ? "集中处理跨课次的待复核、已确认和已放弃草案。" : view === "ai" ? "查看最近五课的完整 AI 生成、学期快照与长期清理状态。" : "查看和清理可恢复的页面工作状态。"} actions={view === "history" ? <Button variant="danger" onClick={() => setDeleteId("")} disabled={!items.length}>清空当前模块</Button> : undefined} />
    <SegmentedControl label="工作历史视图" items={[{ value: "drafts", label: "待复核草案" }, { value: "history", label: "工作记录" }, { value: "ai", label: "AI 生成" }]} value={view} onChange={(value) => setView(value as "history" | "drafts" | "ai")} />
    {view === "drafts" ? <div className="history-draft-center"><AiWorkflowStatus state={reviewWorkflow.state} /><ReviewStep workflow={reviewWorkflow} /></div> : <>
      {view === "ai" ? <GenerationHistoryPanel /> : <>
      <SegmentedControl label="历史模块" items={MODULES} value={module} onChange={(value) => setModule(value as HistoryModule)} />
      <section className="history-list">{loading ? <LoadingState label="加载历史记录中…" /> : error ? <ErrorState message={error} action={<Button onClick={() => void load()}>重试</Button>} /> : items.length === 0 ? <EmptyState title="暂无历史记录" description="在对应工作台保存或生成内容后，历史记录会显示在这里。" /> : items.map((item) => <article key={item.id}><div><strong>{item.title}</strong><span>{new Date(item.createdAt).toLocaleString("zh-CN")}{item.key ? ` · ${item.key}` : ""}</span></div><Button variant="ghost" uiSize="sm" onClick={() => setDeleteId(item.id)}>删除</Button></article>)}</section>
      </>}
    </>}
    <ConfirmDialog open={deleteId !== null} title={deleteId ? "删除历史记录" : "清空当前模块"} description={deleteId ? "确定删除这条历史记录吗？" : "确定清空当前模块的全部历史吗？此操作不可撤销。"} confirmLabel={deleteId ? "删除" : "全部清空"} danger busy={clearing} onConfirm={() => void confirmDelete()} onClose={() => { if (!clearing) setDeleteId(null); }} />
  </main>;
}
