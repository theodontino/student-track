"use client";

import { useEffect, useState } from "react";
import { requestJson } from "@/lib/api-client";
import type { ClassSummary, SemesterSummary, SessionSummary } from "./types";

export function useSemesters(refreshKey = 0) {
  const [items, setItems] = useState<SemesterSummary[]>([]);
  useEffect(() => { requestJson<SemesterSummary[]>("/api/semesters").then(setItems).catch(() => setItems([])); }, [refreshKey]);
  return items;
}
export function useClasses(semesterId: string, refreshKey = 0) {
  const [items, setItems] = useState<ClassSummary[]>([]);
  useEffect(() => {
    if (!semesterId) { setItems([]); return; }
    requestJson<ClassSummary[]>(`/api/semesters/${encodeURIComponent(semesterId)}/classes`)
      .then(setItems)
      .catch(() => setItems([]));
  }, [refreshKey, semesterId]);
  return items;
}
export function useSessions(semesterId: string, classId: string, className: string, refreshKey = 0) {
  const [items, setItems] = useState<SessionSummary[]>([]);
  useEffect(() => {
    if (!semesterId || (!classId && !className)) { setItems([]); return; }
    const controller = new AbortController();
    setItems([]);
    const query = new URLSearchParams({ semesterId });
    if (classId) query.set("classId", classId);
    else query.set("className", className);
    void requestJson<SessionSummary[]>(`/api/sessions?${query}`, { signal: controller.signal })
      .then((sessions) => {
        if (!controller.signal.aborted) setItems(sessions);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        if (!controller.signal.aborted) setItems([]);
      });
    return () => controller.abort();
  }, [classId, className, refreshKey, semesterId]);
  return items;
}
