"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ObservationStatus, TeacherObservationView } from "@/lib/contracts/teaching-summary";
import { Badge, Button, EmptyState, Select } from "@/components/ui";

const statusLabels: Record<ObservationStatus, string> = {
  new: "新发现",
  read: "已阅",
  deferred: "暂缓跟进",
  handled: "已处理",
  ignored: "忽略",
};

const statusOptions: ObservationStatus[] = ["new", "read", "deferred", "handled", "ignored"];

export default function TeacherObservationsPanel({
  items,
  onStatusChange,
  compact = false,
}: {
  items: TeacherObservationView[];
  onStatusChange: (id: string, status: ObservationStatus) => Promise<void>;
  compact?: boolean;
}) {
  const [statusFilter, setStatusFilter] = useState<ObservationStatus | "open" | "all">("open");
  const [classFilter, setClassFilter] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [savingId, setSavingId] = useState("");
  const classes = useMemo(() => (
    [...new Map(items.map((item) => [item.student.classId, item.student.className])).entries()]
  ), [items]);
  const filtered = items.filter((item) => {
    const matchesStatus = statusFilter === "all"
      || statusFilter === "open" && !["handled", "ignored"].includes(item.status)
      || item.status === statusFilter;
    return matchesStatus && (!classFilter || item.student.classId === classFilter);
  });
  const visible = expanded || !compact ? filtered : filtered.slice(0, 5);

  async function changeStatus(id: string, status: ObservationStatus) {
    setSavingId(id);
    try { await onStatusChange(id, status); }
    finally { setSavingId(""); }
  }

  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-xs font-semibold text-gray-500">处理状态
        <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
          <option value="open">待处理</option>
          {statusOptions.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
          <option value="all">全部</option>
        </Select>
      </label>
      <label className="grid gap-1 text-xs font-semibold text-gray-500">班级
        <Select value={classFilter} onChange={(event) => setClassFilter(event.target.value)}>
          <option value="">全部班级</option>
          {classes.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
      </label>
      <Badge tone={filtered.some((item) => item.status === "new") ? "warning" : "neutral"}>{filtered.length} 项</Badge>
    </div>
    {visible.length === 0 ? <EmptyState title="暂无家校沟通观察" description="只有带可追溯沟通证据的教师内部观察才会显示在这里。" /> : <div className="grid gap-3">
      {visible.map((item) => <article key={item.id} className="rounded-2xl border border-amber-300/60 bg-amber-50/90 p-4 text-gray-800 shadow-sm">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div><div className="flex flex-wrap items-center gap-2"><strong>{item.student.name}</strong><span className="text-xs text-gray-500">{item.student.className}</span><Badge tone="warning">{statusLabels[item.status]}</Badge></div><h3 className="mt-2 font-semibold">{item.title}</h3></div>
          <Link className="text-xs font-semibold text-blue-700 hover:underline" href={item.sources[0]?.studentHref ?? item.student.href}>查看档案 →</Link>
        </header>
        <p className="mt-2 text-sm leading-6 text-gray-700">{item.evidenceSummary}</p>
        <details className="mt-3 rounded-xl border border-amber-200 bg-white/70 p-3 text-sm">
          <summary className="cursor-pointer font-semibold text-amber-900">查看 {item.sources.length} 条来源证据</summary>
          <div className="mt-3 grid gap-3">{item.sources.map((source) => <div key={source.communicationId} className="border-l-2 border-amber-300 pl-3"><p className="text-xs text-gray-500">{source.occurredAt.slice(0, 10)} · {source.target} · {source.sessionCode}</p><p className="mt-1 leading-6">{source.summary}</p><Link className="mt-1 inline-block text-xs text-blue-700 hover:underline" href={source.sessionHref}>打开相关课次</Link></div>)}</div>
        </details>
        <div className="mt-4 flex flex-wrap gap-2">
          {statusOptions.filter((status) => status !== item.status).map((status) => <Button key={status} variant="ghost" uiSize="sm" disabled={savingId === item.id} onClick={() => void changeStatus(item.id, status)}>{statusLabels[status]}</Button>)}
        </div>
      </article>)}
    </div>}
    {compact && filtered.length > 5 && <Button variant="ghost" onClick={() => setExpanded((current) => !current)}>{expanded ? "收起观察" : `展开其余 ${filtered.length - 5} 项`}</Button>}
  </div>;
}
