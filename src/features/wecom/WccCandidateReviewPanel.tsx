"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MAX_NEAREST_DISTANCE_DAYS,
  pickNearestWithinDistance,
} from "@/services/wecom-session-matcher";

type Verdict = "confirm" | "reject" | "review";

type Suggestion = {
  verdict: Verdict;
  confidence: number;
  reason: string;
  flags: string[];
};

type SessionOption = { code: string; date: string; semesterNumber: number };

type Candidate = {
  id: string;
  kind: "standard" | "replacement" | "correction";
  supersedesDraftId?: string | null;
  communicationId?: string | null;
  sessionCode: string | null;
  student: { id: string; name: string; studentId: string } | null;
  parsedResult: {
    students?: Array<{ communication?: { type: string; summary: string } }>;
  };
  source: {
    conversation?: { title?: string };
    messageIds?: string[];
    evidence?: Array<{ messageId: string; quote: string }>;
    occurredAt?: { min: string; max: string } | null;
  };
  sessions: SessionOption[];
  createdAt: string;
  preReview?: Suggestion | null;
};

type ListResponse = {
  items: Candidate[];
  total: number;
  limit: number;
  offset: number;
};

type BatchStatus = {
  taskId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

const VERDICT_BADGE: Record<Verdict, { label: string; tone: string }> = {
  confirm: { label: "建议入库", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  reject: { label: "建议忽略", tone: "bg-rose-50 text-rose-700 border-rose-200" },
  review: { label: "需复核", tone: "bg-amber-50 text-amber-700 border-amber-200" },
};

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body as T;
}

const PAGE_SIZE = 25;

export default function WccCandidateReviewPanel() {
  const [items, setItems] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [verdictFilter, setVerdictFilter] = useState<"" | Verdict>("");
  const [onlyMissingSession, setOnlyMissingSession] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sessionOverrides, setSessionOverrides] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "info" | "warn" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<{ kind: string; ids?: string[] } | null>(null);
  const [batch, setBatch] = useState<BatchStatus | null>(null);
  const pollHandle = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPage = useCallback(async (nextOffset: number) => {
    setBusy({ kind: "load" });
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(nextOffset),
        ...(query ? { q: query } : {}),
        ...(verdictFilter ? { verdict: verdictFilter } : {}),
        ...(onlyMissingSession ? { missingSession: "1" } : {}),
      });
      const data = await request<ListResponse>(`/api/wecom/review-drafts?${params.toString()}`);
      setItems(data.items);
      setTotal(data.total);
      setOffset(data.offset);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "加载失败" });
    } finally {
      setBusy(null);
    }
  }, [query, verdictFilter, onlyMissingSession]);

  useEffect(() => {
    void fetchPage(0);
  }, [fetchPage]);

  const refresh = useCallback(() => { void fetchPage(offset); }, [fetchPage, offset]);

  const allOnPageSelected = useMemo(
    () => items.length > 0 && items.every((item) => selected.has(item.id)),
    [items, selected],
  );

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        for (const item of items) next.delete(item.id);
      } else {
        for (const item of items) next.add(item.id);
      }
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const decideOne = async (item: Candidate, action: "confirm" | "reject") => {
    const sessionCode = sessionOverrides[item.id] || item.sessionCode || "";
    if (action === "confirm" && !sessionCode) {
      setMessage({ tone: "warn", text: "请先选择实际课次" });
      return;
    }
    setBusy({ kind: "single", ids: [item.id] });
    try {
      if (action === "confirm" && sessionCode !== item.sessionCode) {
        await request("/api/wecom/review-drafts", {
          method: "PATCH",
          body: JSON.stringify({ draftId: item.id, sessionCode }),
        });
      }
      await request("/api/wecom/review-drafts", {
        method: "POST",
        body: JSON.stringify({ draftId: item.id, action }),
      });
      setMessage({ tone: "info", text: action === "confirm" ? "已确认并写入学生档案" : "已忽略候选" });
      await refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "处理失败" });
    } finally {
      setBusy(null);
    }
  };

  const bulkAction = async (action: "confirm" | "reject") => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const missingSession = items
      .filter((item) => ids.includes(item.id))
      .filter((item) => action === "confirm" && !sessionOverrides[item.id] && !item.sessionCode);
    if (missingSession.length > 0) {
      setMessage({ tone: "warn", text: `${missingSession.length} 条尚未选择课次，已跳过` });
    }
    const eligibleIds = items
      .filter((item) => ids.includes(item.id))
      .filter((item) => !(action === "confirm" && !sessionOverrides[item.id] && !item.sessionCode))
      .map((item) => item.id);
    if (eligibleIds.length === 0) return;

    let readyIds = eligibleIds;
    let sessionUpdateFailures = 0;
    if (action === "confirm") {
      const failedIds = new Set<string>();
      for (const id of eligibleIds) {
        const override = sessionOverrides[id];
        const item = items.find((candidate) => candidate.id === id);
        if (override && override !== item?.sessionCode) {
          try {
            await request("/api/wecom/review-drafts", {
              method: "PATCH",
              body: JSON.stringify({ draftId: id, sessionCode: override }),
            });
          } catch {
            failedIds.add(id);
          }
        }
      }
      readyIds = eligibleIds.filter((id) => !failedIds.has(id));
      sessionUpdateFailures = failedIds.size;
    }

    if (readyIds.length === 0) {
      setMessage({ tone: "error", text: "没有可安全确认的候选；请先处理课次更新失败项" });
      return;
    }

    setBusy({ kind: `bulk-${action}`, ids: readyIds });
    try {
      const result = await request<{ total: number; confirmed: number; rejected: number; failed: Array<{ id: string; error: string }> }>(
        "/api/wecom/review-drafts/bulk",
        { method: "POST", body: JSON.stringify({ draftIds: readyIds, action }) },
      );
      setMessage({
        tone: result.failed.length > 0 ? "warn" : "info",
        text: `完成 ${result.confirmed + result.rejected}/${result.total}，失败 ${result.failed.length}${sessionUpdateFailures ? `；另有 ${sessionUpdateFailures} 条课次更新失败，未入库` : ""}`,
      });
      setSelected(new Set());
      await refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "批量处理失败" });
    } finally {
      setBusy(null);
    }
  };

  const startPreReview = async () => {
    setBusy({ kind: "prereview-start" });
    try {
      const status = await request<BatchStatus>("/api/wecom/review-drafts/preview", { method: "POST", body: "{}" });
      setBatch(status);
      setMessage({ tone: "info", text: `预审任务已启动（${status.total} 条），可继续操作` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "启动预审失败" });
    } finally {
      setBusy(null);
    }
  };

  const cancelPreReview = async () => {
    if (!batch) return;
    try {
      await request<{ cancelled: boolean }>("/api/wecom/review-drafts/preview/status", {
        method: "POST",
        body: JSON.stringify({ taskId: batch.taskId, action: "cancel" }),
      });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "取消失败" });
    }
  };

  const acceptHighConfidence = async (dryRun: boolean) => {
    setBusy({ kind: dryRun ? "accept-dry" : "accept" });
    try {
      const result = await request<{ scanned: number; eligible: number; confirmed: number; failed: Array<{ id: string; error: string }> }>(
        "/api/wecom/review-drafts/accept-confidence",
        { method: "POST", body: JSON.stringify({ threshold: 0.9, dryRun }) },
      );
      setMessage({
        tone: result.failed.length > 0 && !dryRun ? "warn" : "info",
        text: dryRun
          ? `扫描 ${result.scanned} 条，符合高置信的 ${result.eligible} 条`
          : `采纳 ${result.confirmed}/${result.eligible} 条，失败 ${result.failed.length}`,
      });
      await refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "采纳失败" });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!batch || batch.status !== "running") {
      if (pollHandle.current) {
        clearInterval(pollHandle.current);
        pollHandle.current = null;
      }
      return;
    }
    pollHandle.current = setInterval(async () => {
      try {
        const next = await request<BatchStatus>(`/api/wecom/review-drafts/preview/status?taskId=${batch.taskId}`);
        setBatch(next);
        if (next.status !== "running") {
          setMessage({ tone: "info", text: `预审 ${next.status}：成功 ${next.succeeded}，失败 ${next.failed}` });
          void refresh();
        }
      } catch (error) {
        setMessage({ tone: "error", text: error instanceof Error ? error.message : "进度获取失败" });
      }
    }, 3000);
    return () => {
      if (pollHandle.current) clearInterval(pollHandle.current);
      pollHandle.current = null;
    };
  }, [batch, refresh]);

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + items.length;
  const missingOnPage = items.reduce(
    (count, item) => count + (item.sessionCode ? 0 : 1),
    0,
  );

  return <section className="wcc-review-panel space-y-4 rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="font-semibold text-gray-800">WCC 已对齐候选</h3>
        <p className="mt-1 text-sm text-gray-500">Student Track 已完成业务提取；核对证据并选择实际课次后才正式入库。</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded-full bg-blue-50 px-3 py-1 text-blue-700">{total} 项待复核</span>
        {missingOnPage > 0 && (
          <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-800">
            本页 {missingOnPage} 项缺课次
          </span>
        )}
        {selected.size > 0 && <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">已选 {selected.size}</span>}
        {batch && batch.status === "running" && (
          <span className="rounded-full bg-indigo-50 px-3 py-1 text-indigo-700">
            预审 {batch.processed}/{batch.total}
          </span>
        )}
      </div>
    </div>

    {message && <p className={`rounded-lg px-3 py-2 text-sm ${message.tone === "error" ? "bg-rose-50 text-rose-800" : message.tone === "warn" ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-800"}`}>{message.text}</p>}

    <div className="wcc-review-toolbar flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-sm">
      <input
        className="min-w-48 flex-1 rounded-md border border-slate-300 px-2 py-1.5"
        placeholder="搜索学生/学号/会话标题"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <select
        className="rounded-md border border-slate-300 px-2 py-1.5"
        value={verdictFilter}
        onChange={(event) => setVerdictFilter(event.target.value as Verdict | "")}
      >
        <option value="">全部预审结果</option>
        <option value="confirm">仅建议入库</option>
        <option value="reject">仅建议忽略</option>
        <option value="review">仅需复核</option>
      </select>
      <button
        type="button"
        aria-pressed={onlyMissingSession}
        className={`rounded-md border px-3 py-1.5 ${onlyMissingSession ? "border-amber-400 bg-amber-100 text-amber-900" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"}`}
        onClick={() => setOnlyMissingSession((prev) => !prev)}
      >
        只看缺课次
      </button>
      <button className="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-100" onClick={() => { setQuery(""); setVerdictFilter(""); setOnlyMissingSession(false); }}>清空筛选</button>
      <div className="ml-auto flex flex-wrap gap-2">
        <button
          className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-indigo-800 disabled:opacity-50"
          onClick={startPreReview}
          disabled={busy?.kind === "prereview-start" || batch?.status === "running"}
        >
          {batch?.status === "running" ? `预审中 ${batch.processed}/${batch.total}` : "运行 LLM 预审"}
        </button>
        {batch?.status === "running" && (
          <button className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-rose-800" onClick={cancelPreReview}>
            取消预审
          </button>
        )}
        <button
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-emerald-800 disabled:opacity-50"
          onClick={() => acceptHighConfidence(true)}
          disabled={busy?.kind === "accept-dry"}
        >
          统计高置信
        </button>
        <button
          className="rounded-md border border-emerald-300 bg-emerald-100 px-3 py-1.5 text-emerald-900 disabled:opacity-50"
          onClick={() => acceptHighConfidence(false)}
          disabled={busy?.kind === "accept"}
        >
          一键采纳高置信
        </button>
      </div>
    </div>

    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button
        className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-rose-800 disabled:opacity-50"
        disabled={selected.size === 0 || busy?.kind === "bulk-reject"}
        onClick={() => bulkAction("reject")}
      >
        批量忽略 ({selected.size})
      </button>
      <button
        className="rounded-md bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50"
        disabled={selected.size === 0 || busy?.kind === "bulk-confirm"}
        onClick={() => bulkAction("confirm")}
      >
        批量确认入库 ({selected.size})
      </button>
      <span className="ml-auto text-xs text-slate-500">
        {total === 0 ? "暂无候选" : `第 ${pageStart}-${pageEnd} 条 / 共 ${total} 条`}
      </span>
      <button className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 disabled:opacity-30" onClick={() => fetchPage(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>上一页</button>
      <button className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 disabled:opacity-30" onClick={() => fetchPage(offset + PAGE_SIZE)} disabled={pageEnd >= total}>下一页</button>
    </div>

    {items.length === 0 ? (
      <p className="py-12 text-center text-sm text-slate-500">暂时没有匹配的 WCC 候选。</p>
    ) : (
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2"><input type="checkbox" checked={allOnPageSelected} onChange={toggleSelectAll} aria-label="全选当前页" /></th>
              <th className="px-3 py-2">学生</th>
              <th className="px-3 py-2">会话</th>
              <th className="px-3 py-2">预审</th>
              <th className="px-3 py-2">实际课次</th>
              <th className="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item) => {
              const communication = item.parsedResult.students?.[0]?.communication;
              const suggestion = item.preReview || null;
              const confidencePct = suggestion ? Math.round(suggestion.confidence * 100) : 0;
              const sessionValue = sessionOverrides[item.id] ?? item.sessionCode ?? "";
              const isMissingSession = !item.sessionCode;
              const occurredAtMin = item.source.occurredAt?.min;
              const nearestSession = occurredAtMin
                ? pickNearestWithinDistance(item.sessions, occurredAtMin, DEFAULT_MAX_NEAREST_DISTANCE_DAYS)
                : null;
              return <tr key={item.id} className={`align-top ${isMissingSession ? "bg-amber-50/40" : ""}`}>
                <td className="px-3 py-2"><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleOne(item.id)} aria-label={`选择 ${item.id}`} /></td>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{item.student?.name || "学生已失效"}</div>
                  <div className="text-xs text-slate-500">{item.student?.studentId || item.id}</div>
                  {item.kind !== "standard" && <span className={`mt-1 inline-flex rounded border px-1.5 py-0.5 text-[10px] ${item.kind === "correction" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-blue-200 bg-blue-50 text-blue-700"}`}>{item.kind === "correction" ? "沟通纠错" : "替代草案"}</span>}
                </td>
                <td className="px-3 py-2">
                  <div className="text-slate-700">{item.source.conversation?.title || "未命名会话"}</div>
                  <div className="mt-1 line-clamp-2 max-w-md text-xs text-slate-500">{communication?.summary || "没有可显示的沟通摘要"}</div>
                  {!!item.source.evidence?.length && (
                    <details className="mt-1 text-xs text-slate-500">
                      <summary className="cursor-pointer text-blue-700">查看 {item.source.evidence.length} 条原文证据</summary>
                      <div className="mt-1 space-y-1">
                        {item.source.evidence.map((evidence) => (
                          <blockquote key={`${evidence.messageId}-${evidence.quote}`} className="border-l-2 border-amber-300 pl-2 text-slate-600">
                            {evidence.quote}
                            <code className="ml-1 text-[10px] text-slate-400">{evidence.messageId}</code>
                          </blockquote>
                        ))}
                      </div>
                    </details>
                  )}
                </td>
                <td className="px-3 py-2">
                  {suggestion ? (
                    <div className="space-y-1">
                      <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${VERDICT_BADGE[suggestion.verdict].tone}`}>
                        {VERDICT_BADGE[suggestion.verdict].label} · {confidencePct}%
                      </span>
                      <p className="max-w-xs text-xs text-slate-500">{suggestion.reason}</p>
                      {suggestion.flags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {suggestion.flags.map((flag) => (
                            <span key={flag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{flag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">未预审</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className={`min-w-44 rounded-md border px-2 py-1.5 text-sm ${isMissingSession ? "border-amber-400 bg-white text-amber-900" : "border-slate-300"}`}
                      value={sessionValue}
                      onChange={(event) => setSessionOverrides((prev) => ({ ...prev, [item.id]: event.target.value }))}
                    >
                      <option value="">请选择课次…</option>
                      {item.sessions.map((session) => (
                        <option value={session.code} key={session.code}>
                          {session.date} · 第 {session.semesterNumber} 次 · {session.code}
                        </option>
                      ))}
                    </select>
                    {isMissingSession && (
                      <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
                        待选课次
                      </span>
                    )}
                    {isMissingSession && occurredAtMin && nearestSession && (
                      <button
                        type="button"
                        className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] text-emerald-800 hover:bg-emerald-100"
                        onClick={() => setSessionOverrides((prev) => ({ ...prev, [item.id]: nearestSession }))}
                        title={`按消息起始日 ${occurredAtMin} 选本班 30 天内最近一节课`}
                      >
                        按 {occurredAtMin} 选最近一节
                      </button>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      className="rounded-md border border-amber-300 px-3 py-1.5 text-xs text-amber-800 disabled:opacity-50"
                      onClick={() => decideOne(item, "reject")}
                      disabled={busy?.kind === "single"}
                    >
                      忽略
                    </button>
                    <button
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                      onClick={() => decideOne(item, "confirm")}
                      disabled={busy?.kind === "single"}
                    >
                      确认入库
                    </button>
                  </div>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    )}
  </section>;
}
