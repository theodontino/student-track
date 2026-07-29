"use client";

import { useMemo, useState } from "react";
import WorkHistoryButton from "@/components/WorkHistoryButton";
import { Button, FormField, Input, PageHeader, Section, StatusBanner } from "@/components/ui";
import { downloadFile } from "@/lib/api-client";
import { saveWorkHistory } from "@/lib/history";
import { useSessionWorkspace } from "@/lib/use-session-workspace";

interface ExportHistoryState { startDate: string; endDate: string; includeInactive?: boolean; }
function isExportHistoryState(value: unknown): value is ExportHistoryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ExportHistoryState>;
  return typeof state.startDate === "string" && typeof state.endDate === "string";
}

export default function ExportWorkspace() {
  const today = new Date().toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const [startDate, setStartDate] = useState(thirtyDaysAgo);
  const [endDate, setEndDate] = useState(today);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const workspaceValue = useMemo<ExportHistoryState>(() => ({ startDate, endDate, includeInactive }), [endDate, includeInactive, startDate]);

  function restore(state: ExportHistoryState) { setStartDate(state.startDate); setEndDate(state.endDate); setIncludeInactive(state.includeInactive ?? false); setError(""); setStatus(""); }
  useSessionWorkspace({ key: "export", value: workspaceValue, validate: isExportHistoryState, restore: (saved) => { if (saved) restore(saved); } });

  async function handleExport() {
    setLoading(true); setError(""); setStatus("");
    try {
      await downloadFile("/api/export", `Student-Track_${startDate}_${endDate}.xlsx`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ startDate, endDate, includeInactive }) });
      setStatus("Excel 已生成并下载。");
      try { await saveWorkHistory("export", `${startDate} 至 ${endDate} 数据导出`, { startDate, endDate, includeInactive }, `${startDate}:${endDate}`); }
      catch (historyError) { console.error("save export history failed:", historyError); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "导出失败"); }
    finally { setLoading(false); }
  }

  return <main className="export-workspace">
    <PageHeader title="数据导出" description="选择时间范围，导出学生数据的 Excel 文件。" actions={<WorkHistoryButton<ExportHistoryState> module="export" onRestore={restore} />} />
    <Section title="导出范围" description="文件包含学生档案、指标历史、关键事件、家校沟通和考勤五个工作表。">
      <div className="export-form">
        <FormField id="export-start" label="开始日期"><Input id="export-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></FormField>
        <FormField id="export-end" label="结束日期"><Input id="export-end" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></FormField>
        <label className="check-row"><input type="checkbox" checked={includeInactive} onChange={(event) => setIncludeInactive(event.target.checked)} /><span><strong>包含非活跃学生</strong><small>默认仅导出当前在读学生；开启后保留非活跃学生的历史记录并标注状态。</small></span></label>
        <div className="export-sheet-list"><strong>导出内容</strong><ol><li>学生档案</li><li>每日指标历史</li><li>关键事件日志</li><li>家校沟通记录</li><li>考勤记录</li></ol></div>
        {error && <StatusBanner tone="danger">{error}</StatusBanner>}{status && <StatusBanner tone="success">{status}</StatusBanner>}
        <Button uiSize="lg" onClick={() => void handleExport()} disabled={loading}>{loading ? "生成中…" : "导出 Excel"}</Button>
      </div>
    </Section>
  </main>;
}
