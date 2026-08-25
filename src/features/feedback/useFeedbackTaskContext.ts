"use client";

import { useCallback, useEffect, useState } from "react";
import { requestJson } from "@/lib/api-client";
import { useTeachingContext } from "@/features/teaching-context/use-teaching-context";
import type { FeedbackContextResponse } from "./types";

function today() {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export function useFeedbackTaskContext() {
  const teaching = useTeachingContext();
  const [data, setData] = useState<FeedbackContextResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newSessionDate, setNewSessionDate] = useState(today);
  const [creatingSession, setCreatingSession] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!teaching.hydrated || !teaching.context.semesterId || !teaching.context.sessionCode) { setData(null); return; }
    let cancelled = false;
    setLoading(true); setError("");
    const query = new URLSearchParams({ semesterId: teaching.context.semesterId, sessionCode: teaching.context.sessionCode });
    requestJson<FeedbackContextResponse>(`/api/report/feedback-context?${query}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((reason) => { if (!cancelled) { setData(null); setError(reason instanceof Error ? reason.message : "读取课次上下文失败"); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, teaching.context.semesterId, teaching.context.sessionCode, teaching.hydrated]);

  const switchSession = useCallback((entry: { className: string; sessionCode: string }) => {
    teaching.setContext((current) => ({ ...current, className: entry.className, classId: "", sessionCode: entry.sessionCode }));
  }, [teaching]);

  const createSession = useCallback(async () => {
    if (!teaching.context.semesterId || !teaching.context.className) throw new Error("请先选择学期和班级");
    setCreatingSession(true); setError("");
    try {
      const result = await requestJson<{ code: string }>(`/api/semesters/${encodeURIComponent(teaching.context.semesterId)}/session`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ className: teaching.context.className, date: newSessionDate }),
      });
      teaching.setSessionCode(result.code);
      setRefreshKey((value) => value + 1);
      return result.code;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "新建课次失败";
      setError(message); throw new Error(message);
    } finally { setCreatingSession(false); }
  }, [newSessionDate, teaching]);

  return {
    ...teaching,
    data, loading, error, setError, newSessionDate, setNewSessionDate, creatingSession, createSession,
    refreshKey,
    refresh: () => setRefreshKey((value) => value + 1), switchSession,
  };
}
