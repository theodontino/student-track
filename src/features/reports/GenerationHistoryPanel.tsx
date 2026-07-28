"use client";

import { useEffect, useState } from "react";
import { Badge, Button, EmptyState, ErrorState, LoadingState, Textarea } from "@/components/ui";
import { requestJson } from "@/lib/api-client";

interface GenerationRecordView {
  id: string;
  taskType: string;
  stage: string;
  lifecycle: "hot" | "warm" | "purged";
  modelName: string;
  generatedAt: string;
  adoptedAt: string | null;
  sessionId: string | null;
  studentId: string | null;
  inputSnapshot: string | null;
  outputSnapshot: string | null;
  warmSnapshot: string | null;
}

interface LongTermDraftView { id: string; scopeName: string; content: string; generatedAt: string; }

const lifecycleLabel = { hot: "完整可复盘", warm: "学期快照", purged: "长期已清理" } as const;

export function GenerationHistoryPanel() {
  const [items, setItems] = useState<GenerationRecordView[] | null>(null);
  const [drafts, setDrafts] = useState<LongTermDraftView[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void requestJson<{ history: GenerationRecordView[]; drafts: LongTermDraftView[] }>("/api/teaching-memory")
      .then((data) => { if (active) { setItems(data.history); setDrafts(data.drafts); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "加载 AI 生成历史失败"); });
    return () => { active = false; };
  }, []);
  if (error) return <ErrorState message={error} />;
  if (items === null) return <LoadingState label="正在载入 AI 生成历史…" />;
  if (!items.length && !drafts.length) return <EmptyState title="暂无 AI 生成历史" description="成功完成并通过业务校验的生成结果会出现在这里。" />;
  async function confirmDraft(draft: LongTermDraftView) {
    try {
      await requestJson(`/api/teaching-memory`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: draft.id, content: draft.content }) });
      setDrafts((current) => current.filter((item) => item.id !== draft.id));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "确认长期背景失败"); }
  }
  return <section className="generation-history-list" aria-label="AI 生成历史">
    {drafts.map((draft) => <article key={draft.id} className="generation-history-draft"><header><div><strong>{draft.scopeName} · 长期背景草案</strong><span>{new Date(draft.generatedAt).toLocaleString("zh-CN")}</span></div><Badge tone="warning">待教师确认</Badge></header><Textarea value={draft.content} onChange={(event) => setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, content: event.target.value } : item))} /><Button uiSize="sm" onClick={() => void confirmDraft(draft)}>确认并启用长期背景</Button></article>)}
    {items.map((item) => <article key={item.id}>
      <header><div><strong>{item.taskType} · {item.stage}</strong><span>{new Date(item.generatedAt).toLocaleString("zh-CN")} · {item.modelName}</span></div><Badge tone={item.lifecycle === "hot" ? "info" : item.lifecycle === "warm" ? "warning" : "neutral"}>{lifecycleLabel[item.lifecycle]}</Badge></header>
      <p>{item.lifecycle === "hot" ? "完整业务输入与结果仍在最近五课窗口内。" : item.lifecycle === "warm" ? "完整输入和成文已压缩，仅保留可追溯学期快照。" : "仅保留最小审计账本与已确认长期背景来源。"}</p>
      {item.adoptedAt && <small>已在导出或保存时采纳</small>}
    </article>)}
  </section>;
}
