"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ArchiveButton from "@/components/ArchiveButton";
import DashboardOverview from "./DashboardOverview";
import type { DashboardData } from "./types";
import { ErrorState, LoadingState, PageHeader, Select } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { useTeachingContext, type SemesterSummary } from "@/features/teaching-context";
import TeacherTaskPanel from "./TeacherTaskPanel";

export default function DashboardWorkspace() {
  const [semesters, setSemesters] = useState<SemesterSummary[]>([]);
  const { context, hydrated, setSemesterId } = useTeachingContext();
  const selectedSemesterId = context.semesterId;
  const selectedSemesterName = selectedSemesterId
    ? semesters.find((semester) => semester.id === selectedSemesterId)?.name
    : undefined;
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const headerSemesterName = selectedSemesterName ?? data?.semester?.name;

  const fetchData = useCallback(async (semesterId: string) => {
    setLoading(true); setError("");
    try { const query = semesterId ? `?semesterId=${encodeURIComponent(semesterId)}` : ""; const dashboard = await requestJson<DashboardData>(`/api/alerts${query}`); setData(dashboard); if (!semesterId && dashboard.semester) setSemesterId(dashboard.semester.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取仪表盘失败"); }
    finally { setLoading(false); }
  }, [setSemesterId]);

  useEffect(() => {
    requestJson<SemesterSummary[]>("/api/semesters").then(setSemesters).catch(() => setSemesters([]));
  }, []);
  useEffect(() => { if (hydrated) void fetchData(selectedSemesterId); }, [fetchData, hydrated, selectedSemesterId]);

  function selectSemester(semesterId: string) {
    setSemesterId(semesterId);
  }

  return <div className="mx-auto max-w-6xl">
    <PageHeader title="仪表盘" description={headerSemesterName ? `${headerSemesterName} · 学期概览与风险提示` : "学期概览与风险提示"} context={<label className="block min-w-48 text-xs font-semibold text-gray-500">查看学期<Select className="mt-1" value={selectedSemesterId} onChange={(event) => selectSemester(event.target.value)}><option value="">当前学期</option>{semesters.map((semester) => <option key={semester.id} value={semester.id}>{semester.name}</option>)}</Select></label>} />
    {loading ? <LoadingState label="正在加载仪表盘…" /> : error ? <ErrorState message={error} /> : data ? <DashboardOverview data={data} showFeedbackShortcut /> : null}
    {!loading && !error && <div className="mt-6"><TeacherTaskPanel semesterId={selectedSemesterId || data?.semester?.id} /></div>}
    <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-6"><ArchiveButton onSuccess={() => fetchData(selectedSemesterId)} /><Link href="/system/maintenance" className="text-xs text-gray-500 hover:text-blue-700">维护与操作日志</Link></div>
  </div>;
}
