"use client";

import { useCallback, useEffect, useState } from "react";
import { requestJson } from "@/lib/api-client";
import { Badge, Button, ConfirmDialog, EmptyState, Input, Section, StatusBanner } from "@/components/ui";

interface AttentionBatch {
  id: string;
  conversationTitle: string;
  status: "needs_review" | "failed";
  messageCount: number;
  canRetry: boolean;
  canReextract: boolean;
  attemptCount: number;
  failureCode: string | null;
  reviewReasonCodes: string | null;
  modelName: string | null;
  finishReason: string | null;
  promptVersion: string | null;
  reasoningTokens: number | null;
  completionTokens: number | null;
  responseCharacters: number | null;
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
  cancelRequestedAt: string | null;
  cancelMode: string | null;
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
  | { kind: "reextract"; id: string; label: string; changeModel: boolean }
  | { kind: "ignore"; id: string; label: string }
  | {
    kind: "bulk";
    action: "retry" | "reextract" | "ignore";
    ids: string[];
    label: string;
  };

const INITIAL_VISIBLE_BATCHES = 5;
const VISIBLE_BATCH_STEP = 20;
const INITIAL_VISIBLE_RUNS = 4;
const VISIBLE_RUN_STEP = 4;
const BULK_BATCH_LIMIT = 50;

const failureLabels: Record<string, string> = {
  protocol_incompatible: "协议不兼容",
  output_truncated: "输出截断",
  schema_invalid: "Schema 校验失败",
  network_error: "网络错误",
  provider_error: "模型服务错误",
  oversized_message: "超长消息待人工复核",
  batch_failed: "批次处理失败",
  evidence_mismatch: "原文证据不匹配",
  candidate_validation_failed: "候选业务校验失败",
  student_outside_conversation_candidates: "学生不在会话候选范围",
  matched_student_confidence_not_allowed: "学生匹配置信度不足",
  missing_source_message_ids: "缺少来源消息",
  source_message_outside_batch: "消息引用越界",
  occurred_at_required_for_session: "缺少有效沟通时间",
  prior_session_not_found: "没有可绑定课次",
  prior_session_too_distant: "最近课次超过 30 天",
};

function reasonText(batch: AttentionBatch) {
  let codes: string[] = [];
  try {
    const parsed = JSON.parse(batch.reviewReasonCodes || "[]") as unknown;
    if (Array.isArray(parsed)) codes = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    codes = [];
  }
  const primary = batch.failureCode ? [batch.failureCode] : [];
  return [...new Set([...primary, ...codes])].map((code) => failureLabels[code] || code).join("、");
}

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
  const [visibleCounts, setVisibleCounts] = useState<Record<string, number>>({});
  const [visibleRunCount, setVisibleRunCount] = useState(INITIAL_VISIBLE_RUNS);

  const load = useCallback(async () => {
    try {
      setData(await requestJson<RollbackResponse>("/api/system/wecom-rollbacks"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取企微回滚记录失败");
    }
  }, []);

  useEffect(() => {
    void load();
    if (!data?.state?.activeRunId) return;
    const timer = window.setInterval(() => void load(), 2_000);
    return () => window.clearInterval(timer);
  }, [load, data?.state?.activeRunId]);

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
          : pending.kind === "reextract"
            ? { action: "retry-extraction", batchId: pending.id }
          : pending.kind === "ignore"
            ? { action: "ignore-batch", batchId: pending.id }
            : { action: "bulk-batches", batchAction: pending.action, batchIds: pending.ids };
    try {
      const result = await requestJson<{
        batchCount?: number;
        communicationCount?: number;
        labelCount?: number;
        createdCount?: number;
        requested?: number;
        succeeded?: number;
        failed?: number;
      }>("/api/system/wecom-rollbacks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (pending.kind === "bulk") {
        const actionLabel = pending.action === "retry" ? "重新校验" : pending.action === "reextract" ? "重新排队" : "确认忽略";
        setStatus(`批量${actionLabel}完成：成功 ${result.succeeded ?? 0} 项，保留 ${result.failed ?? 0} 项。`);
      } else if (pending.kind === "retry") {
        setStatus(`已重新校验，新增 ${result.createdCount ?? 0} 条沟通。`);
      } else if (pending.kind === "reextract") {
        setStatus("失败交流段已重新排队；下次一键导入会使用当前企微提取模型。");
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
        className="wecom-rollback-section"
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
          <Button variant="warning" onClick={() => setPending({ kind: "date", date })} disabled={!date || busy}>回滚当天企微导入</Button>
        </div>

        {status && <StatusBanner tone="success">{status}</StatusBanner>}
        {error && <StatusBanner tone="danger">{error}</StatusBanner>}

        {!data || data.runs.length === 0 ? (
          <EmptyState title="暂无企微导入记录" description="完成一次一键导入后会出现在这里。" />
        ) : (
          <div className="wecom-rollback-runs">
            {data.runs.slice(0, visibleRunCount).map((run) => {
              const label = run.conversations.slice(0, 2).join("、") || "企微导入";
              const canRollback = run.communicationCount > 0 && !["rolled_back", "running"].includes(run.status);
              const visibleCount = visibleCounts[run.id] ?? INITIAL_VISIBLE_BATCHES;
              const visibleBatches = run.attentionBatches.slice(0, visibleCount);
              const retryable = run.attentionBatches.filter((batch) => batch.canRetry);
              const reextractable = run.attentionBatches.filter((batch) => batch.canReextract);
              const bulkSelection = (batches: AttentionBatch[]) => batches.slice(0, BULK_BATCH_LIMIT).map((batch) => batch.id);
              return (
                <article key={run.id} className="wecom-rollback-run">
                  <header className="wecom-rollback-run__header">
                    <div className="wecom-rollback-run__identity">
                      <div className="wecom-rollback-run__title">
                        <strong>{label}</strong>
                        <Badge tone={run.status === "complete" ? "success" : run.status === "rolled_back" ? "neutral" : "warning"}>
                          {run.status === "complete" ? "可回滚" : run.status === "rolled_back" ? "已回滚" : run.status === "running" ? "运行中" : run.status === "failed" ? "运行失败" : run.status === "cancelled" ? "已停止" : run.status === "interrupted" ? "已中断" : "需要处理"}
                        </Badge>
                      </div>
                      <p>
                        {new Date(run.startedAt).toLocaleString("zh-CN")}
                        {` · ${run.batchCount} 批 · ${run.messageCount} 条消息 · ${run.communicationCount} 条沟通 · ${run.labelCount} 个标签`}
                      </p>
                    </div>
                    <Button
                      variant="warning"
                      uiSize="sm"
                      disabled={!canRollback || busy}
                      onClick={() => setPending({ kind: "run", id: run.id, label })}
                    >回滚这次运行</Button>
                  </header>

                  {run.attentionBatches.length > 0 && (
                    <div className="wecom-rollback-attention">
                      <div className="wecom-rollback-attention__summary">
                        <div>
                          <strong>{run.attentionBatches.length} 项待处理</strong>
                          <span>可重新校验 {retryable.length} 项 · 可重新提取 {reextractable.length} 项</span>
                        </div>
                        <div className="wecom-rollback-attention__bulk-actions">
                          {retryable.length > 0 && <Button
                            variant="secondary"
                            uiSize="sm"
                            disabled={busy}
                            onClick={() => setPending({
                              kind: "bulk",
                              action: "retry",
                              ids: bulkSelection(retryable),
                              label,
                            })}
                          >批量校验 {Math.min(retryable.length, BULK_BATCH_LIMIT)} 项</Button>}
                          {reextractable.length > 0 && <Button
                            variant="secondary"
                            uiSize="sm"
                            disabled={busy}
                            onClick={() => setPending({
                              kind: "bulk",
                              action: "reextract",
                              ids: bulkSelection(reextractable),
                              label,
                            })}
                          >批量重新排队 {Math.min(reextractable.length, BULK_BATCH_LIMIT)} 项</Button>}
                          <Button
                            variant="ghost"
                            uiSize="sm"
                            disabled={busy}
                            onClick={() => setPending({
                              kind: "bulk",
                              action: "ignore",
                              ids: bulkSelection(run.attentionBatches),
                              label,
                            })}
                          >批量忽略 {Math.min(run.attentionBatches.length, BULK_BATCH_LIMIT)} 项</Button>
                        </div>
                      </div>
                      <p className="wecom-rollback-attention__hint">为避免误操作和瞬时大量调用，每次最多处理 {BULK_BATCH_LIMIT} 项；失败项会保留。</p>
                      <div className="wecom-rollback-attention__list">
                      {visibleBatches.map((batch) => (
                        <div key={batch.id} className="wecom-rollback-batch">
                          <span className="wecom-rollback-batch__summary">
                            {batch.conversationTitle} · {reasonText(batch)
                              || (batch.status === "needs_review" ? "已读但未写入" : "处理失败")}
                            {` · ${batch.messageCount} 条 · 已尝试 ${batch.attemptCount} 次`}
                          </span>
                          {(batch.modelName || batch.finishReason || batch.completionTokens !== null) && (
                            <span className="wecom-rollback-batch__meta">
                              {[batch.modelName, batch.finishReason && `结束：${batch.finishReason}`,
                                batch.completionTokens !== null && `输出 token：${batch.completionTokens}`,
                                batch.reasoningTokens !== null && `推理 token：${batch.reasoningTokens}`,
                                batch.responseCharacters !== null && `正文：${batch.responseCharacters} 字符`]
                                .filter(Boolean).join(" · ")}
                            </span>
                          )}
                          <div className="wecom-rollback-batch__actions">
                            {batch.canRetry && <Button
                              variant="secondary"
                              uiSize="sm"
                              disabled={busy}
                              onClick={() => setPending({ kind: "retry", id: batch.id, label: batch.conversationTitle })}
                            >重新校验候选</Button>}
                            {batch.canReextract && <Button
                              variant="secondary"
                              uiSize="sm"
                              disabled={busy}
                              onClick={() => setPending({
                                kind: "reextract",
                                id: batch.id,
                                label: batch.conversationTitle,
                                changeModel: batch.failureCode === "protocol_incompatible",
                              })}
                            >{batch.failureCode === "protocol_incompatible" ? "更换模型后重试" : "重新提取失败段"}</Button>}
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
                      {visibleBatches.length < run.attentionBatches.length && <Button
                        variant="ghost"
                        uiSize="sm"
                        disabled={busy}
                        onClick={() => setVisibleCounts((current) => ({
                          ...current,
                          [run.id]: Math.min(
                            (current[run.id] ?? INITIAL_VISIBLE_BATCHES) + VISIBLE_BATCH_STEP,
                            run.attentionBatches.length,
                          ),
                        }))}
                      >再显示 {Math.min(VISIBLE_BATCH_STEP, run.attentionBatches.length - visibleBatches.length)} 项（已显示 {visibleBatches.length}/{run.attentionBatches.length}）</Button>}
                    </div>
                  )}
                </article>
              );
            })}
            {visibleRunCount < data.runs.length && <Button
              className="wecom-rollback-runs__more"
              variant="secondary"
              uiSize="sm"
              disabled={busy}
              onClick={() => setVisibleRunCount((current) => Math.min(current + VISIBLE_RUN_STEP, data.runs.length))}
            >显示更多运行（已显示 {visibleRunCount}/{data.runs.length}）</Button>}
          </div>
        )}
      </Section>

      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.kind === "retry"
          ? "重新校验候选"
          : pending?.kind === "reextract"
            ? pending.changeModel ? "更换模型后重试" : "重新提取失败段"
            : pending?.kind === "ignore"
              ? "确认忽略候选"
              : pending?.kind === "bulk"
                ? pending.action === "retry" ? "批量重新校验" : pending.action === "reextract" ? "批量重新排队" : "批量确认忽略"
                : "确认回滚企微导入"}
        description={pending?.kind === "run"
          ? `将删除“${pending.label}”这次运行新增的沟通；仍被其他批次支持的标签会保留。原始企微聊天不受影响。`
          : pending?.kind === "date"
            ? `将回滚 ${pending.date} 当天所有可回滚的企微导入。`
            : pending?.kind === "retry"
              ? `将重新校验“${pending.label}”，只有全部检查通过才会写入。`
              : pending?.kind === "reextract"
                ? `将“${pending.label}”重新排队；下次一键导入才会调用当前配置的企微提取模型。`
              : pending?.kind === "bulk"
                ? `将对“${pending.label}”的 ${pending.ids.length} 个批次执行${pending.action === "retry" ? "重新校验" : pending.action === "reextract" ? "重新排队" : "确认忽略"}。各批次独立处理，失败项会继续保留。`
                : `将“${pending?.label || ""}”标记为已忽略并删除暂存候选。`}
        confirmLabel={pending?.kind === "retry" ? "重新校验" : pending?.kind === "reextract" ? "重新排队" : pending?.kind === "ignore" ? "确认忽略" : pending?.kind === "bulk" ? `处理 ${pending.ids.length} 项` : "确认回滚"}
        warning={pending?.kind === "ignore" || (pending?.kind === "bulk" && pending.action === "ignore") || pending?.kind === "run" || pending?.kind === "date"}
        busy={busy}
        onConfirm={() => void performAction()}
        onClose={() => setPending(null)}
      />
    </>
  );
}
