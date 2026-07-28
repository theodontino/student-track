"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, StatusBanner } from "@/components/ui";

type StudentOption = { id: string; name: string; studentId: string };
type HandoffItem = {
  id: string;
  packageId: string;
  sourceId: string;
  status: string;
  outcome: string | null;
  code: string | null;
  messageCount: number;
  selectedStudent: StudentOption | null;
  producedAt: string;
  updatedAt: string;
};

type HandoffResponse = {
  items: HandoffItem[];
  students: StudentOption[];
};
type ReceiptRepairPreview = {
  alreadyLinked: number;
  missingReceiptId: number;
  eligible: number;
  linkExisting: number;
  createReceipt: number;
  skipped: Record<string, number>;
};

const STATUS_LABELS: Record<string, string> = {
  discovered: "已发现",
  processing: "正在处理",
  pending_alignment: "需要人工匹配",
  pending_review: "已进入教师复核",
  no_value: "无需长期保留",
  retryable_failure: "可重试",
  rejected: "已拒绝",
  discarded: "已丢弃",
};

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

export default function WccHandoffPanel() {
  const [data, setData] = useState<HandoffResponse>({ items: [], students: [] });
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [receiptPreview, setReceiptPreview] = useState<ReceiptRepairPreview | null>(null);
  const [repairConfirmation, setRepairConfirmation] = useState("");
  const refresh = () => request("/api/wecom/handoff")
    .then(setData)
    .catch((error) => setMessage(error.message));
  useEffect(() => { void refresh(); }, []);

  const counts = useMemo(() => ({
    attention: data.items.filter((item) => ["pending_alignment", "retryable_failure", "rejected"].includes(item.status)).length,
    pendingReview: data.items.filter((item) => item.status === "pending_review").length,
    complete: data.items.filter((item) => ["no_value", "discarded"].includes(item.status)).length,
  }), [data.items]);

  async function scan() {
    setBusy("scan");
    setMessage("");
    try {
      const result = await request("/api/wecom/handoff", {
        method: "POST",
        body: JSON.stringify({ limit: 50 }),
      });
      setMessage(`已检查 ${result.scanned} 个文件包：接收 ${result.accepted}，待匹配 ${result.pendingAlignment}，重复跳过 ${result.duplicates}${result.failed ? `，异常 ${result.failed}` : ""}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "扫描失败");
    } finally {
      setBusy("");
    }
  }

  async function act(item: HandoffItem, action: "align" | "retry" | "discard") {
    const studentId = selection[item.id] || item.selectedStudent?.id;
    if (action === "align" && !studentId) {
      setMessage("请先选择要匹配的学生");
      return;
    }
    setBusy(item.id);
    try {
      await request(`/api/wecom/handoff/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ action, studentId }),
      });
      setMessage(action === "discard" ? "已丢弃；WCC 原始归档未被删除" : "处理完成");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "处理失败");
    } finally {
      setBusy("");
    }
  }

  async function previewReceipts() {
    setBusy("receipt-preview");
    try {
      const preview = await request("/api/wecom/handoff/receipt-repair") as ReceiptRepairPreview;
      setReceiptPreview(preview);
      setMessage(`回执只读预检完成：${preview.eligible} 条可修复，${Object.values(preview.skipped).reduce((sum, count) => sum + count, 0)} 条跳过`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回执预检失败");
    } finally {
      setBusy("");
    }
  }

  async function repairReceipts() {
    setBusy("receipt-repair");
    try {
      const result = await request("/api/wecom/handoff/receipt-repair", {
        method: "POST",
        body: JSON.stringify({ confirmation: repairConfirmation }),
      });
      setRepairConfirmation("");
      setReceiptPreview(null);
      setMessage(`回执修复完成：关联已有 ${result.linkedExisting}，新建 ${result.createdReceipts}；数据库备份已验证`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回执修复失败");
    } finally {
      setBusy("");
    }
  }

  return <section className="handoff-panel">
    <div className="handoff-panel__header">
      <div>
        <span className="handoff-panel__eyebrow">离线文件协议 v1</span>
        <h3>WCC 中转仓库</h3>
        <p>扫描 WCC 已发布的证据包，在本机完成学生匹配、二次提取和教师复核。WCC 无需保持运行。</p>
      </div>
      <Button onClick={() => void scan()} disabled={busy === "scan"}>
        {busy === "scan" ? "正在扫描与接收…" : "扫描并接收新包"}
      </Button>
    </div>
    <div className="handoff-panel__metrics">
      <span><strong>{data.items.length}</strong>已登记</span>
      <span><strong>{counts.pendingReview}</strong>待教师复核</span>
      <span><strong>{counts.attention}</strong>需要介入</span>
      <span><strong>{counts.complete}</strong>无需处理</span>
    </div>
    <div className="handoff-item__actions">
      <Button variant="secondary" onClick={() => void previewReceipts()} disabled={Boolean(busy)}>
        {busy === "receipt-preview" ? "正在预检回执…" : "只读预检历史回执"}
      </Button>
      {receiptPreview && <span>
        缺少关联 {receiptPreview.missingReceiptId} · 可关联已有 {receiptPreview.linkExisting} · 可新建 {receiptPreview.createReceipt}
      </span>}
      {receiptPreview?.eligible ? <>
        <input
          aria-label="回执修复确认"
          value={repairConfirmation}
          onChange={(event) => setRepairConfirmation(event.target.value)}
          placeholder="输入 REPAIR_HANDOFF_RECEIPTS"
        />
        <Button
          variant="secondary"
          onClick={() => void repairReceipts()}
          disabled={repairConfirmation !== "REPAIR_HANDOFF_RECEIPTS" || Boolean(busy)}
        >
          {busy === "receipt-repair" ? "正在备份并修复…" : "备份后修复 receiptId"}
        </Button>
      </> : null}
    </div>
    {message && <StatusBanner tone={message.includes("失败") ? "warning" : "info"}>{message}</StatusBanner>}
    {data.items.length === 0 ? <EmptyState
      title="还没有收到转交文件"
      description="先在 WeComCatch 的“中转仓库”发布已准备项目，再回到这里扫描。"
    /> : <div className="handoff-panel__list">
      {data.items.map((item) => <article className={`handoff-item handoff-item--${item.status}`} key={item.id}>
        <div className="handoff-item__main">
          <div className="handoff-item__title">
            <strong>{item.selectedStudent?.name || "尚未匹配学生"}</strong>
            <span>{STATUS_LABELS[item.status] || item.status}</span>
          </div>
          <p>{item.messageCount} 条候选消息 · {new Date(item.producedAt).toLocaleString("zh-CN")}</p>
          <code>{item.packageId}</code>
          {item.code && <small>安全错误码：{item.code}</small>}
        </div>
        <div className="handoff-item__actions">
          {item.status === "pending_alignment" && <>
            <select
              aria-label="匹配学生"
              value={selection[item.id] || ""}
              onChange={(event) => setSelection({ ...selection, [item.id]: event.target.value })}
            >
              <option value="">选择学生…</option>
              {data.students.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.studentId}</option>)}
            </select>
            <Button onClick={() => void act(item, "align")} disabled={busy === item.id}>确认匹配并处理</Button>
          </>}
          {item.status === "retryable_failure" && <Button onClick={() => void act(item, "retry")} disabled={busy === item.id}>重试</Button>}
          {["pending_alignment", "retryable_failure", "rejected"].includes(item.status)
            && <Button variant="secondary" onClick={() => void act(item, "discard")} disabled={busy === item.id}>丢弃</Button>}
        </div>
      </article>)}
    </div>}
  </section>;
}
