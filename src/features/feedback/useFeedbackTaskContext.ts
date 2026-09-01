"use client";

import { useCallback, useEffect, useState } from "react";
import { requestJson } from "@/lib/api-client";
import { useTeachingContext } from "@/features/teaching-context/use-teaching-context";
import type { TeachingContext } from "@/features/teaching-context/types";
import type { FeedbackContextResponse } from "./types";

type FeedbackTaskContextSelection = {
  semesterId: string;
  classId?: string;
  sessionCode: string;
};

export function isFeedbackTaskContextCurrent(
  data: FeedbackContextResponse | null,
  selection: FeedbackTaskContextSelection,
) {
  return Boolean(
    data?.session
    && selection.semesterId
    && selection.classId
    && selection.sessionCode
    && data.session.semesterId === selection.semesterId
    && data.session.classId === selection.classId
    && data.session.code === selection.sessionCode,
  );
}

export function feedbackClassSelection(
  current: TeachingContext,
  className: string,
  classId = "",
): TeachingContext {
  if (current.className === className && (current.classId ?? "") === classId) return current;
  const isStableIdPromotion = current.className === className && !current.classId && Boolean(classId);
  return {
    ...current,
    className,
    classId,
    sessionCode: isStableIdPromotion ? current.sessionCode : "",
  };
}

export function useFeedbackTaskContext() {
  const teaching = useTeachingContext();
  const [data, setData] = useState<FeedbackContextResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!teaching.hydrated || !teaching.context.semesterId || !teaching.context.sessionCode) {
      setData(null);
      setLoading(false);
      setError("");
      return;
    }
    let cancelled = false;
    setData(null);
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ semesterId: teaching.context.semesterId, sessionCode: teaching.context.sessionCode });
    requestJson<FeedbackContextResponse>(`/api/report/feedback-context?${query}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((reason) => { if (!cancelled) { setData(null); setError(reason instanceof Error ? reason.message : "读取课次上下文失败"); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, teaching.context.classId, teaching.context.semesterId, teaching.context.sessionCode, teaching.hydrated]);

  const switchSession = useCallback((entry: { classId: string; className: string; sessionCode: string }) => {
    teaching.setContext((current) => ({
      ...current,
      classId: entry.classId,
      className: entry.className,
      sessionCode: entry.sessionCode,
    }));
  }, [teaching]);

  const setClass = useCallback((className: string, classId = "") => {
    teaching.setContext((current) => feedbackClassSelection(current, className, classId));
  }, [teaching]);

  const currentData = isFeedbackTaskContextCurrent(data, teaching.context) ? data : null;

  return {
    ...teaching,
    setClass,
    data: currentData,
    loading,
    error,
    setError,
    refreshKey,
    refresh: () => setRefreshKey((value) => value + 1), switchSession,
  };
}
