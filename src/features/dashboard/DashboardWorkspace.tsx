"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ArchiveButton from "@/components/ArchiveButton";
import DashboardOverview, { type DashboardData } from "@/components/DashboardOverview";
import { ErrorState, LoadingState, PageHeader, Select } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import type { SemesterSummary } from "@/features/teaching-context";

export default function DashboardWorkspace() {
  const [semesters, setSemesters] = useState<SemesterSummary[]>([]);
  const [selectedSemesterId, setSelectedSemesterId] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async (semesterId: string) => {
    setLoading(true); setError("");
    try { const query = semesterId ? `?semesterId=${encodeURIComponent(semesterId)}` : ""; const dashboard = await requestJson<DashboardData>(`/api/alerts${query}`); setData(dashboard); if (!semesterId && dashboard.semester) setSelectedSemesterId(dashboard.semester.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取仪表盘失败"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const semesterId = new URLSearchParams(window.location.search).get("semesterId") ?? "";
    requestJson<SemesterSummary[]>("/api/semesters").then(setSemesters).catch(() => setSemesters([]));
    setSelectedSemesterId(semesterId); void fetchData(semesterId);
  }, [fetchData]);

  function selectSemester(semesterId: string) {
    setSelectedSemesterId(semesterId);
    const url = new URL(window.location.href); if (semesterId) url.searchParams.set("semesterId", semesterId); else url.searchParams.delete("semesterId"); window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
    void fetchData(semesterId);
  }

  return <div className="mx-auto max-w-6xl">
    <PageHeader title="仪表盘" description={data?.semester ? `${data.semester.name} · 学期概览与风险提示` : "学期概览与风险提示"} context={<label className="block min-w-48 text-xs font-semibold text-gray-500">查看学期<Select className="mt-1" value={selectedSemesterId} onChange={(event) => selectSemester(event.target.value)}><option value="">当前学期</option>{semesters.map((semester) => <option key={semester.id} value={semester.id}>{semester.name}</option>)}</Select></label>} />
    {loading ? <LoadingState label="正在加载仪表盘…" /> : error ? <ErrorState message={error} /> : data ? <DashboardOverview data={data} showFeedbackShortcut /> : null}
    <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-6"><ArchiveButton onSuccess={() => fetchData(selectedSemesterId)} /><Link href="/system/maintenance" className="text-xs text-gray-500 hover:text-blue-700">维护与操作日志</Link></div>
  </div>;
}
