"use client";

import { useEffect, useState } from "react";
import { Card, EmptyState, LoadingState, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";

interface MemoryRow {
  id: string;
  memoryTier: string;
  status: string;
  content: string;
  updatedAt: string;
}

export function StudentTeachingMemory({ studentId, semesterId }: { studentId: string; semesterId?: string }) {
  const [items, setItems] = useState<MemoryRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setItems(null); setError("");
    const query = new URLSearchParams({ studentId });
    if (semesterId) query.set("semesterId", semesterId);
    void requestJson<{ memories: MemoryRow[] }>(`/api/teaching-memory?${query}`)
      .then((value) => { if (active) setItems(value.memories); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "加载教学背景失败"); });
    return () => { active = false; };
  }, [studentId, semesterId]);

  return <Card className="student-teaching-memory">
    <header><div><h2>长期教学背景</h2><p>仅教师内部查看；当前不进入家长反馈 prompt、预览或导出。</p></div></header>
    {error ? <StatusBanner tone="danger">{error}</StatusBanner> : items === null ? <LoadingState label="正在载入教学背景…" /> : (() => {
      const longTerm = items.find((item) => item.memoryTier === "long-term");
      return longTerm ? <article><p>{longTerm.content}</p><small>最近确认：{new Date(longTerm.updatedAt).toLocaleDateString("zh-CN")}</small></article> : <EmptyState title="暂无已确认长期背景" description="系统会在旧学期内容归档后生成草案，教师确认后才会显示在这里。" />;
    })()}
  </Card>;
}
