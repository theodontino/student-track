"use client";

import { useCallback, useEffect, useState } from "react";
import { requestJson } from "@/lib/api-client";
import type { SystemLogEntry, SystemLogsResponse } from "./maintenance-types";

const LIMIT = 50;

export function useMaintenanceLogs() {
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [filterTargetName, setFilterTargetName] = useState("");
  const [offset, setOffset] = useState(0);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: "0" });
      if (filterAction) params.set("action", filterAction);
      if (filterTargetName) params.set("targetName", filterTargetName);
      const data = await requestJson<SystemLogsResponse>(`/api/system/logs?${params}`);
      setLogs(data.logs);
      setOffset(LIMIT);
      setTotal(data.total ?? 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取操作日志失败");
    } finally {
      setLoading(false);
    }
  }, [filterAction, filterTargetName]);

  useEffect(() => { void loadInitial(); }, [loadInitial]);

  async function loadMore() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
      if (filterAction) params.set("action", filterAction);
      if (filterTargetName) params.set("targetName", filterTargetName);
      const data = await requestJson<SystemLogsResponse>(`/api/system/logs?${params}`);
      setLogs((current) => [...current, ...data.logs]);
      setOffset((current) => current + LIMIT);
      setTotal(data.total ?? 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载更多日志失败");
    } finally {
      setLoading(false);
    }
  }

  return {
    error,
    filterAction,
    filterTargetName,
    loadInitial,
    loadMore,
    loading,
    logs,
    setFilterAction,
    setFilterTargetName,
    total,
  };
}
