"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Input, Select, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import {
  feedbackScriptEntryHasContent,
  type FeedbackScriptLibraryResponse,
} from "@/lib/feedback-script-library";
import type { useFeedbackWorkspace } from "./useFeedbackWorkspace";

type Workspace = ReturnType<typeof useFeedbackWorkspace>;

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function FeedbackScriptLibraryPanel({ workspace }: { workspace: Workspace }) {
  const { semesterId, sessionCode } = workspace.context;
  const [data, setData] = useState<FeedbackScriptLibraryResponse>({
    library: null,
    recommendedLessonNumber: null,
  });
  const [selectedLesson, setSelectedLesson] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    setError("");
    setStatus("");
    setFile(null);
    if (!semesterId) {
      setData({ library: null, recommendedLessonNumber: null });
      setSelectedLesson("");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ semesterId });
    if (sessionCode) params.set("sessionCode", sessionCode);
    void requestJson<FeedbackScriptLibraryResponse>(`/api/feedback/script-library?${params}`, {
      signal: controller.signal,
    }).then((response) => {
      setData(response);
      const recommended = response.recommendedLessonNumber;
      const entries = response.library?.entries ?? [];
      setSelectedLesson(String(
        recommended && entries.some((entry) => entry.lessonNumber === recommended)
          ? recommended
          : entries[0]?.lessonNumber ?? "",
      ));
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(messageFrom(reason, "获取话术库失败"));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [semesterId, sessionCode]);

  const selectedEntry = useMemo(() => data.library?.entries.find(
    (entry) => String(entry.lessonNumber) === selectedLesson,
  ) ?? null, [data.library, selectedLesson]);

  async function importLibrary() {
    if (!file || !semesterId) return;
    setImporting(true);
    setError("");
    setStatus("");
    try {
      const formData = new FormData();
      formData.set("semesterId", semesterId);
      if (sessionCode) formData.set("sessionCode", sessionCode);
      formData.set("file", file);
      const response = await requestJson<FeedbackScriptLibraryResponse>("/api/feedback/script-library", {
        method: "POST",
        body: formData,
      });
      setData(response);
      const entries = response.library?.entries ?? [];
      const recommended = response.recommendedLessonNumber;
      setSelectedLesson(String(
        recommended && entries.some((entry) => entry.lessonNumber === recommended)
          ? recommended
          : entries[0]?.lessonNumber ?? "",
      ));
      setFile(null);
      setStatus(`已保存 ${entries.length} 个课次的话术，本学期后续可直接选择。`);
    } catch (reason) {
      setError(messageFrom(reason, "导入话术库失败"));
    } finally {
      setImporting(false);
    }
  }

  function applySelected() {
    if (!selectedEntry) return;
    workspace.applyFeedbackScriptEntry(selectedEntry);
    setStatus(`已将第 ${selectedEntry.lessonNumber} 课话术填入本节反馈材料。`);
  }

  return (
    <div className="feedback-script-library">
      <div className="feedback-script-library__heading">
        <div>
          <strong>学期话术库</strong>
          <span>每学期上传一次；选择课次后再明确套用，不会自动覆盖当前材料。</span>
        </div>
        {data.library && <Badge tone="success">已保存 {data.library.entries.length} 课</Badge>}
      </div>

      {!semesterId && <StatusBanner tone="info">先选择学期，即可上传或使用该学期的话术库。</StatusBanner>}
      {error && <StatusBanner tone="danger">{error}</StatusBanner>}
      {status && <StatusBanner tone="success">{status}</StatusBanner>}

      {semesterId && (
        <div className="feedback-script-library__controls">
          <label>
            <span>{data.library ? "替换话术库" : "上传话术库"}</span>
            <Input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <Button
            variant="secondary"
            onClick={() => void importLibrary()}
            disabled={!file || importing}
          >
            {importing ? "导入中…" : data.library ? "确认替换" : "上传并保存"}
          </Button>
        </div>
      )}

      {data.library && (
        <>
          <div className="feedback-script-library__picker">
            <label>
              <span>本节进度</span>
              <Select value={selectedLesson} onChange={(event) => setSelectedLesson(event.target.value)} disabled={loading}>
                {data.library.entries.map((entry) => (
                  <option key={entry.lessonNumber} value={entry.lessonNumber}>
                    第 {entry.lessonNumber} 课{entry.topic ? ` · ${entry.topic}` : ""}{feedbackScriptEntryHasContent(entry) ? "" : " · 未配置"}
                  </option>
                ))}
              </Select>
            </label>
            <Button onClick={applySelected} disabled={!selectedEntry || !feedbackScriptEntryHasContent(selectedEntry)}>
              套用本节话术
            </Button>
          </div>
          {selectedEntry && (
            <>
              <div className="feedback-script-library__summary">
                <span>群反馈：{selectedEntry.groupFeedback ? "已配置" : "未配置"}</span>
                <span>全对私反馈：{selectedEntry.perfectPrivateFeedback ? "已配置" : "未配置"}</span>
                <span>有误私反馈：{selectedEntry.errorPrivateFeedback ? "已配置" : "未配置"}</span>
                {selectedEntry.note && <span>备注：{selectedEntry.note}</span>}
              </div>
              {(selectedEntry.perfectPrivateFeedback || selectedEntry.errorPrivateFeedback) && (
                <details className="feedback-script-library__preview">
                  <summary>查看本节私反馈话术</summary>
                  {selectedEntry.perfectPrivateFeedback && <div><strong>全对</strong><p>{selectedEntry.perfectPrivateFeedback}</p></div>}
                  {selectedEntry.errorPrivateFeedback && <div><strong>有误</strong><p>{selectedEntry.errorPrivateFeedback}</p></div>}
                </details>
              )}
            </>
          )}
          {data.library.warnings.length > 0 && (
            <details className="feedback-script-library__warnings">
              <summary>导入提示（{data.library.warnings.length}）</summary>
              <ul>{data.library.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
