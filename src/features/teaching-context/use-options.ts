"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, requestJson } from "@/lib/api-client";
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

export type ClassOptionsResource = {
  items: ClassSummary[];
  phase: "idle" | "loading" | "ready" | "error";
  error: string;
  diagnosticId?: string;
  retry: () => void;
};

/**
 * Resource state for a workflow which must distinguish an empty class list
 * from a list that could not be read. Keep useClasses above as the lightweight
 * array-only API used by existing selectors.
 */
export function useClassOptionsResource(semesterId: string, refreshKey = 0): ClassOptionsResource {
  const [items, setItems] = useState<ClassSummary[]>([]);
  const [phase, setPhase] = useState<ClassOptionsResource["phase"]>("idle");
  const [error, setError] = useState("");
  const [diagnosticId, setDiagnosticId] = useState<string>();
  const [retryKey, setRetryKey] = useState(0);
  const requestSequence = useRef(0);
  const retry = useCallback(() => setRetryKey((current) => current + 1), []);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    if (!semesterId) {
      setItems([]);
      setPhase("idle");
      setError("");
      setDiagnosticId(undefined);
      return;
    }
    const controller = new AbortController();
    setItems([]);
    setPhase("loading");
    setError("");
    setDiagnosticId(undefined);
    void requestJson<ClassSummary[]>(`/api/semesters/${encodeURIComponent(semesterId)}/classes`, { signal: controller.signal })
      .then((nextItems) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setItems(nextItems);
        setPhase("ready");
      })
      .catch((reason) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return;
        setItems([]);
        setPhase("error");
        setError(reason instanceof Error ? reason.message : "获取班级列表失败");
        setDiagnosticId(reason instanceof ApiError ? reason.diagnosticId : undefined);
      });
    return () => controller.abort();
  }, [refreshKey, retryKey, semesterId]);

  return { items, phase, error, diagnosticId, retry };
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
