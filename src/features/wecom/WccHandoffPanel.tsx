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
type AlignmentRecoveryPreview = {
  total: number;
  inspected: number;
  eligible: number;
  manual: number;
  uninspected: number;
  reasons: Record<string, number>;
};
type PackageDetail = {
  id: string;
  packageId: string;
  packageSha256: string;
  status: string;
  code: string | null;
  conversation: { title?: string };
  timeRange: { start?: string | null; end?: string | null };
  classification: { reasons?: string[]; classifier?: string };
  messages: Array<{
    id: string;
    sentAt?: string | null;
    sender?: string | null;
    direction?: string | null;
    type?: string | null;
    content: string;
    confidence?: number | null;
  }>;
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

const ERROR_HELP: Record<string, string> = {
  service_unavailable: "提取模型当时不可用或返回了无法处理的结果；修复模型后可批量重试。",
  internal_error: "本机处理未完成；可先查看包内容与运行状态，再重试。",
  evidence_mismatch: "模型生成的摘要或引用不能由原始消息逐字证明，已阻止写入。",
  hash_mismatch: "包文件或完成标记的 SHA-256 不一致，不能安全读取。",
  invalid_package: "包结构不符合 handoff v1，不能安全读取。",
  package_conflict: "同一包身份存在不同内容，系统拒绝覆盖不可变历史。",
  unsupported_contract: "该包使用了当前 Student Track 不支持的协议版本。",
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
  const [alignmentPreview, setAlignmentPreview] = useState<AlignmentRecoveryPreview | null>(null);
  const [alignmentConfirmation, setAlignmentConfirmation] = useState("");
  const [filter, setFilter] = useState<"alignment" | "errors" | "review" | "complete" | "all">("alignment");
  const [selectedRetries, setSelectedRetries] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Record<string, PackageDetail>>({});
  const refresh = () => request("/api/wecom/handoff")
    .then(setData)
    .catch((error) => setMessage(error.message));
  useEffect(() => { void refresh(); }, []);

  const counts = useMemo(() => ({
    pendingAlignment: data.items.filter((item) => item.status === "pending_alignment").length,
    errors: data.items.filter((item) => ["retryable_failure", "rejected"].includes(item.status)).length,
    pendingReview: data.items.filter((item) => item.status === "pending_review").length,
    complete: data.items.filter((item) => ["no_value", "discarded"].includes(item.status)).length,
  }), [data.items]);
  const visibleItems = useMemo(() => data.items.filter((item) => {
    if (filter === "alignment") return item.status === "pending_alignment";
    if (filter === "errors") return ["retryable_failure", "rejected"].includes(item.status);
    if (filter === "review") return item.status === "pending_review";
    if (filter === "complete") return ["no_value", "discarded"].includes(item.status);
    return true;
  }), [data.items, filter]);
  const retryableVisibleIds = useMemo(
    () => visibleItems.filter((item) => item.status === "retryable_failure" || (filter === "complete" && item.status === "no_value")).map((item) => item.id).slice(0, 25),
    [filter, visibleItems],
  );
  const allVisibleRetriesSelected = retryableVisibleIds.length > 0
    && retryableVisibleIds.every((id) => selectedRetries.has(id));

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
      const result = await request(`/api/wecom/handoff/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ action, studentId }),
      });
      setMessage(action === "discard"
        ? "已丢弃；WCC 原始归档未被删除"
        : result.status === "pending_alignment"
          ? "所选学生在证据对应学期没有唯一归属，请核对学期名单"
          : "处理完成");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "处理失败");
    } finally {
      setBusy("");
    }
  }

  async function loadDetail(item: HandoffItem) {
    if (details[item.id]) {
      setDetails((current) => { const next = { ...current }; delete next[item.id]; return next; });
      return;
    }
    setBusy(`detail-${item.id}`);
    try {
      const detail = await request(`/api/wecom/handoff/${encodeURIComponent(item.id)}`) as PackageDetail;
      setDetails((current) => ({ ...current, [item.id]: detail }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取包内容失败");
    } finally {
      setBusy("");
    }
  }

  async function retrySelected() {
    const ids = [...selectedRetries];
    if (!ids.length) return;
    setBusy("batch-retry");
    try {
      const result = await request(
        "/api/wecom/handoff/batch-retry",
        { method: "POST", body: JSON.stringify({ ids }) },
      ) as { total: number; recovered: number; stillRetryable: number; failed: number; skipped: number };
      setMessage(`批量重试 ${result.total} 项：已恢复 ${result.recovered}，仍需重试 ${result.stillRetryable}，失败 ${result.failed}，跳过 ${result.skipped}`);
      setSelectedRetries(new Set());
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量重试失败");
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

  async function previewAlignments() {
    setBusy("alignment-preview");
    try {
      const preview = await request("/api/wecom/handoff/alignment-recovery") as AlignmentRecoveryPreview;
      setAlignmentPreview(preview);
      setMessage(`待匹配只读预检完成：${preview.eligible} 条可自动恢复，${preview.manual} 条仍需人工确认${preview.uninspected ? `，${preview.uninspected} 条未纳入本次预检` : ""}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "待匹配预检失败");
    } finally {
      setBusy("");
    }
  }

  async function recoverAlignments() {
    setBusy("alignment-recovery");
    try {
      const result = await request("/api/wecom/handoff/alignment-recovery", {
        method: "POST",
        body: JSON.stringify({ confirmation: alignmentConfirmation, limit: 25 }),
      });
      setAlignmentConfirmation("");
      setAlignmentPreview(null);
      setMessage(`待匹配恢复完成：尝试 ${result.attempted}，已送复核或完成 ${result.recovered}，仍待匹配 ${result.stillPending}，异常 ${result.failed}；另有 ${result.remainingEligible} 条可继续处理`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "待匹配恢复失败");
    } finally {
      setBusy("");
    }
  }

  return <section className="handoff-panel">
    <div className="handoff-panel__header">
      <div>
        <span className="handoff-panel__eyebrow">离线文件协议 v1</span>
        <h3>接收与诊断</h3>
        <p>扫描不可变 handoff 包、查看完整证据、处理匹配或模型异常。正式沟通只在“教师复核”确认后写入。</p>
      </div>
      <Button onClick={() => void scan()} disabled={busy === "scan"}>
        {busy === "scan" ? "正在扫描与接收…" : "扫描并接收新包"}
      </Button>
    </div>
    <div className="handoff-panel__metrics">
      <span><strong>{data.items.length}</strong>已登记</span>
      <span><strong>{counts.pendingAlignment}</strong>待匹配</span>
      <span><strong>{counts.pendingReview}</strong>已送教师复核</span>
      <span><strong>{counts.errors}</strong>接收异常</span>
      <span><strong>{counts.complete}</strong>已完成</span>
    </div>
    {counts.pendingAlignment > 0 && <div className="handoff-item__actions">
      <Button variant="secondary" onClick={() => void previewAlignments()} disabled={Boolean(busy)}>
        {busy === "alignment-preview" ? "正在预检待匹配…" : "只读预检待匹配"}
      </Button>
      {alignmentPreview && <span>
        已检查 {alignmentPreview.inspected}/{alignmentPreview.total} · 可自动恢复 {alignmentPreview.eligible} · 仍需人工 {alignmentPreview.manual}
      </span>}
      {alignmentPreview?.eligible ? <>
        <input
          aria-label="待匹配恢复确认"
          value={alignmentConfirmation}
          onChange={(event) => setAlignmentConfirmation(event.target.value)}
          placeholder="输入 REPROCESS_MATCHABLE_HANDOFFS"
        />
        <Button
          onClick={() => void recoverAlignments()}
          disabled={alignmentConfirmation !== "REPROCESS_MATCHABLE_HANDOFFS" || Boolean(busy)}
        >
          {busy === "alignment-recovery" ? "正在顺序处理…" : "确认处理最多 25 条"}
        </Button>
      </> : null}
    </div>}
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
    /> : <>
      <div className="handoff-item__actions">
        <label>查看
          <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
            <option value="alignment">仅待匹配</option>
            <option value="errors">仅接收异常</option>
            <option value="review">已送教师复核</option>
            <option value="complete">已完成</option>
            <option value="all">全部已登记</option>
          </select>
        </label>
        {(filter === "errors" || filter === "complete") && <Button
          variant="secondary"
          disabled={!retryableVisibleIds.length || Boolean(busy)}
          onClick={() => setSelectedRetries((current) => {
            const next = new Set(current);
            if (allVisibleRetriesSelected) {
              for (const id of retryableVisibleIds) next.delete(id);
            } else {
              for (const id of retryableVisibleIds) next.add(id);
            }
            return next;
          })}
        >
          {allVisibleRetriesSelected ? `取消选择当前 ${retryableVisibleIds.length} 项` : filter === "complete" ? `选择当前 ${retryableVisibleIds.length} 个重新分拣` : `选择当前 ${retryableVisibleIds.length} 个可重试包`}
        </Button>}
        {(filter === "errors" || filter === "complete") && <Button
          disabled={!selectedRetries.size || Boolean(busy)}
          onClick={() => void retrySelected()}
        >
          {busy === "batch-retry" ? `正在顺序处理 ${selectedRetries.size} 项…` : filter === "complete" ? `用当前模型重新分拣 (${selectedRetries.size}/25)` : `顺序批量重试 (${selectedRetries.size}/25)`}
        </Button>}
        <span>每包均可展开查看完整消息与安全诊断。</span>
      </div>
      {visibleItems.length === 0 ? <EmptyState title="当前筛选没有项目" description="可切换状态查看已送复核或历史完成记录。" /> : <div className="handoff-panel__list">
      {visibleItems.map((item) => <article className={`handoff-item handoff-item--${item.status}`} key={item.id}>
        <div className="handoff-item__main">
          <div className="handoff-item__title">
            {(item.status === "retryable_failure" || (filter === "complete" && item.status === "no_value")) && <input
              aria-label={`选择重试 ${item.packageId}`}
              type="checkbox"
              checked={selectedRetries.has(item.id)}
              onChange={() => setSelectedRetries((current) => {
                const next = new Set(current);
                if (next.has(item.id)) next.delete(item.id); else if (next.size < 25) next.add(item.id);
                return next;
              })}
            />}
            <strong>{item.selectedStudent?.name || "尚未匹配学生"}</strong>
            <span>{STATUS_LABELS[item.status] || item.status}</span>
          </div>
          <p>{item.messageCount} 条候选消息 · {new Date(item.producedAt).toLocaleString("zh-CN")}</p>
          <code>{item.packageId}</code>
          {item.code && <small>安全错误码：{item.code} · {ERROR_HELP[item.code] || "请查看包内容与本机模型设置。"}</small>}
          <Button variant="secondary" onClick={() => void loadDetail(item)} disabled={busy === `detail-${item.id}`}>
            {busy === `detail-${item.id}` ? "正在读取…" : details[item.id] ? "收起包内容" : "查看包内容与诊断"}
          </Button>
          {details[item.id] && <div className="handoff-item__detail">
            <p>会话：{details[item.id].conversation.title || "未命名"} · 时间：{details[item.id].timeRange.start || "未知"} 至 {details[item.id].timeRange.end || "未知"}</p>
            <p>分类：{details[item.id].classification.reasons?.join("、") || "无"} · SHA-256：<code>{details[item.id].packageSha256}</code></p>
            {details[item.id].messages.map((message) => <blockquote key={message.id}>
              <strong>{message.sender || "未知发送者"}</strong> · {message.sentAt || "时间未知"} · {message.direction || "方向未知"}<br />
              {message.content}<br /><code>{message.id}</code>
            </blockquote>)}
          </div>}
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
          {filter === "complete" && item.status === "no_value" && <Button onClick={() => void act(item, "retry")} disabled={busy === item.id}>重新分拣</Button>}
          {["pending_alignment", "retryable_failure", "rejected"].includes(item.status)
            && <Button variant="secondary" onClick={() => void act(item, "discard")} disabled={busy === item.id}>丢弃</Button>}
        </div>
      </article>)}
    </div>}</>}
  </section>;
}
