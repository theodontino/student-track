"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ConfirmDialog, EmptyState, Input, Section, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";

interface AttentionBatch {
  id: string;
  conversationTitle: string;
  status: "needs_review" | "failed";
  messageCount: number;
  canRetry: boolean;
}

interface ImportRun {
  id: string;
  status: string;
  messageCount: number;
  batchCount: number;
  communicationCount: number;
  labelCount: number;
  startedAt: string;
  completedAt: string | null;
  rolledBackAt: string | null;
  conversations: string[];
  attentionBatches: AttentionBatch[];
}

interface RollbackResponse {
  runs: ImportRun[];
  receiptCounts: Record<string, number>;
  state: {
    lastSucceededUntil: string | null;
    activeRunId: string | null;
  } | null;
  retention: { days: number; runs: number; safetyBackups: number };
}

type PendingRollback =
  | { kind: "run"; id: string; label: string }
  | { kind: "date"; date: string }
  | { kind: "retry"; id: string; label: string }
  | { kind: "ignore"; id: string; label: string };

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function WeComRollbackPanel() {
  const [data, setData] = useState<RollbackResponse | null>(null);
  const [date, setDate] = useState(localDate);
  const [pending, setPending] = useState<PendingRollback | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await requestJson<RollbackResponse>("/api/system/wecom-rollbacks"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取企微回滚记录失败");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function performAction() {
    if (!pending) return;
    setBusy(true);
    setError("");
    setStatus("");
    const body = pending.kind === "run"
      ? { action: "rollback-run", runId: pending.id }
      : pending.kind === "date"
        ? { action: "rollback-date", date: pending.date }
        : pending.kind === "retry"
          ? { action: "retry-batch", batchId: pending.id }
          : { action: "ignore-batch", batchId: pending.id };
    try {
      const result = await requestJson<{
        batchCount?: number;
        communicationCount?: number;
        labelCount?: number;
        createdCount?: number;
      }>("/api/system/wecom-rollbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (pending.kind === "retry") {
        setStatus(`已重新校验，新增 ${result.createdCount ?? 0} 条沟通。`);
      } else if (pending.kind === "ignore") {
        setStatus("已确认忽略该批次，之后不会自动写入。");
      } else {
        setStatus(`已回滚 ${result.batchCount ?? 0} 批，删除 ${result.communicationCount ?? 0} 条沟通和 ${result.labelCount ?? 0} 个标签关联。`);
      }
      setPending(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "企微操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Section
        title="企微导入记录与回滚"
        description={`长期只保存增量变更；最多保留 ${data?.retention.runs ?? 30} 次运行或 ${data?.retention.days ?? 30} 天。真正回滚前会创建校验备份，最多保留 ${data?.retention.safetyBackups ?? 3} 份。`}
      >
        <div className="flex flex-wrap gap-2">
          <Badge tone="success">
            已完成 {(data?.receiptCounts.imported ?? 0) + (data?.receiptCounts.no_value ?? 0) + (data?.receiptCounts.ignored ?? 0)}
          </Badge>
          <Badge tone={(data?.receiptCounts.needs_review ?? 0) + (data?.receiptCounts.failed ?? 0) > 0 ? "warning" : "neutral"}>
            已读未写 / 失败 {(data?.receiptCounts.needs_review ?? 0) + (data?.receiptCounts.failed ?? 0)}
          </Badge>
          <Badge tone={data?.state?.activeRunId ? "info" : "neutral"}>
            {data?.state?.activeRunId ? "一键导入运行中" : "当前无运行任务"}
          </Badge>
        </div>
        <p className="text-xs text-gray-500">
          上次成功水位：{data?.state?.lastSucceededUntil
            ? new Date(data.state.lastSucceededUntil).toLocaleString("zh-CN")
            : "尚未完成首次运行"}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-48 text-sm text-gray-700">
            <span className="mb-1 block font-medium">按日期回滚</span>
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <Button variant="danger" onClick={() => setPending({ kind: "date", date })} disabled={!date || busy}>回滚当天企微导入</Button>
        </div>

        {status && <StatusBanner tone="success">{status}</StatusBanner>}
        {error && <StatusBanner tone="danger">{error}</StatusBanner>}

        {!data || data.runs.length === 0 ? (
          <EmptyState title="暂无企微导入记录" description="完成一次一键导入后会出现在这里。" />
        ) : (
          <div className="space-y-3">
            {data.runs.map((run) => {
              const label = run.conversations.slice(0, 2).join("、") || "企微导入";
              const canRollback = run.communicationCount > 0 && !["rolled_back", "failed"].includes(run.status);
              return (
                <div key={run.id} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="truncate text-sm text-gray-800">{label}</strong>
                        <Badge tone={run.status === "complete" ? "success" : run.status === "rolled_back" ? "neutral" : "warning"}>
                          {run.status === "complete" ? "可回滚" : run.status === "rolled_back" ? "已回滚" : run.status === "failed" ? "运行失败" : "需要处理"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {new Date(run.startedAt).toLocaleString("zh-CN")}
                        {` · ${run.batchCount} 批 · ${run.messageCount} 条消息 · ${run.communicationCount} 条沟通 · ${run.labelCount} 个标签`}
                      </p>
                    </div>
                    <Button
                      variant="danger"
                      uiSize="sm"
                      disabled={!canRollback || busy}
                      onClick={() => setPending({ kind: "run", id: run.id, label })}
                    >回滚这次运行</Button>
                  </div>

                  {run.attentionBatches.length > 0 && (
                    <div className="mt-3 space-y-2 border-t border-gray-100 pt-3">
                      {run.attentionBatches.map((batch) => (
                        <div key={batch.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 p-2">
                          <span className="text-sm text-gray-700">
                            {batch.conversationTitle} · {batch.status === "needs_review" ? "已读但未写入" : "处理失败"}
                          </span>
                          <div className="flex gap-2">
                            <Button
                              variant="secondary"
                              uiSize="sm"
                              disabled={!batch.canRetry || busy}
                              onClick={() => setPending({ kind: "retry", id: batch.id, label: batch.conversationTitle })}
                            >重新校验</Button>
                            <Button
                              variant="ghost"
                              uiSize="sm"
                              disabled={busy}
                              onClick={() => setPending({ kind: "ignore", id: batch.id, label: batch.conversationTitle })}
                            >确认忽略</Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.kind === "retry" ? "重新校验候选" : pending?.kind === "ignore" ? "确认忽略候选" : "确认回滚企微导入"}
        description={pending?.kind === "run"
          ? `将删除“${pending.label}”这次运行新增的沟通；仍被其他批次支持的标签会保留。原始企微聊天不受影响。`
          : pending?.kind === "date"
            ? `将回滚 ${pending.date} 当天所有可回滚的企微导入。`
            : pending?.kind === "retry"
              ? `将重新校验“${pending.label}”，只有全部检查通过才会写入。`
              : `将“${pending?.label || ""}”标记为已忽略并删除暂存候选。`}
        confirmLabel={pending?.kind === "retry" ? "重新校验" : pending?.kind === "ignore" ? "确认忽略" : "确认回滚"}
        danger={pending?.kind !== "retry"}
        busy={busy}
        onConfirm={() => void performAction()}
        onClose={() => setPending(null)}
      />
    </>
  );
}
