"use client";

import { useEffect, useMemo, useState } from "react";
import FeedbackContextPreview from "@/components/FeedbackContextPreview";
import SemesterPicker from "@/components/SemesterPicker";
import WeComWorkflowPanel from "@/components/wecom/WeComWorkflowPanel";
import WorkHistoryButton from "@/components/WorkHistoryButton";
import { readSSEStream } from "@/lib/sse";
import type { FeedbackContextStudent } from "@/components/wecom/types";

interface FeedbackCard {
  id: string;
  name: string;
  labels: string[];
  feedback: string;
}

interface FeedbackContextResponse {
  className: string;
  total: number;
  students: FeedbackContextStudent[];
}

interface FeedbackHistoryState {
  kind: "batch";
  semesterId: string;
  sessionCode: string;
  className: string;
  students: FeedbackCard[];
  total: number;
}

type ParsedStudent = {
  name: string;
  scores: { A: number | null; B: number | null; C: number | null };
  events?: string[];
  present?: boolean;
};

function statusTone(active: boolean) {
  return active ? "border-blue-200 bg-blue-50 text-blue-700" : "border-gray-200 bg-white text-gray-500";
}

export default function FeedbackWorkbenchPage() {
  const [semesterId, setSemesterId] = useState("");
  const [className, setClassName] = useState("");
  const [sessionCode, setSessionCode] = useState("");
  const [rawText, setRawText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState("");
  const [streamContent, setStreamContent] = useState("");
  const [draftId, setDraftId] = useState("");
  const [parsedResult, setParsedResult] = useState<any>(null);
  const [reviewResult, setReviewResult] = useState<any>(null);
  const [corrections, setCorrections] = useState<any[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState("");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [feedbackCards, setFeedbackCards] = useState<FeedbackCard[]>([]);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackDone, setFeedbackDone] = useState(0);
  const [contextStudents, setContextStudents] = useState<FeedbackContextStudent[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [contextReloadKey, setContextReloadKey] = useState(0);
  const [feedbackDirty, setFeedbackDirty] = useState(false);
  const [forceRegenerate, setForceRegenerate] = useState(false);

  const canParse = Boolean(rawText.trim() && sessionCode && !parsing);
  const canConfirm = Boolean(draftId && parsedResult && !confirming);
  const canGenerate = Boolean(sessionCode && !generating);
  const dimLabel: Record<string, string> = { A: "学习", B: "纪律", C: "作业" };

  const contextByStudent = useMemo(() => {
    return new Map(contextStudents.map((student) => [student.id, student]));
  }, [contextStudents]);

  useEffect(() => {
    const draft = sessionStorage.getItem("chem-track:feedback-draft");
    if (!draft) return;
    setRawText(draft);
    setParseStatus("已从录音转写载入课后回顾。");
    sessionStorage.removeItem("chem-track:feedback-draft");
  }, []);

  useEffect(() => {
    if (!sessionCode) {
      setContextStudents([]);
      setContextError("");
      return;
    }

    let cancelled = false;
    async function loadFeedbackContext() {
      setContextLoading(true);
      setContextError("");
      try {
        const res = await fetch(`/api/report/feedback-context?sessionCode=${encodeURIComponent(sessionCode)}`);
        const data: FeedbackContextResponse | { error?: string } = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error((data as { error?: string }).error || "读取反馈上下文失败");
        setContextStudents((data as FeedbackContextResponse).students || []);
      } catch (e: any) {
        if (!cancelled) {
          setContextStudents([]);
          setContextError(e.message || "读取反馈上下文失败");
        }
      } finally {
        if (!cancelled) setContextLoading(false);
      }
    }

    void loadFeedbackContext();
    return () => { cancelled = true; };
  }, [sessionCode, contextReloadKey]);

  function onSemIdChange(id: string) {
    setSemesterId(id);
    setClassName("");
    setSessionCode("");
    setFeedbackCards([]);
    setFeedbackDirty(false);
    setForceRegenerate(false);
  }

  function onClsChange(cls: string) {
    setClassName(cls);
    setSessionCode("");
    setFeedbackCards([]);
    setFeedbackDirty(false);
    setForceRegenerate(false);
  }

  function onSessionChange(code: string) {
    setSessionCode(code);
    setDraftId("");
    setParsedResult(null);
    setReviewResult(null);
    setCorrections([]);
    setConfirmed(false);
    setFeedbackCards([]);
    setFeedbackTotal(0);
    setFeedbackDone(0);
    setFeedbackDirty(false);
    setForceRegenerate(false);
    setError("");
    setStatus("");
  }

  function setParsedAttendance(index: number, present: boolean) {
    setParsedResult((current: any) => current ? {
      ...current,
      students: current.students.map((student: ParsedStudent, studentIndex: number) =>
        studentIndex === index ? { ...student, present } : student
      ),
    } : current);
  }

  async function handleParse() {
    if (!rawText.trim()) { setError("请输入课后回顾"); return; }
    if (!sessionCode) { setError("请选择课次，未提及学生将按缺勤处理"); return; }
    setParsing(true);
    setError("");
    setStatus("");
    setStreamContent("");
    setDraftId("");
    setParsedResult(null);
    setReviewResult(null);
    setCorrections([]);
    setConfirmed(false);

    try {
      const res = await fetch("/api/input/parse?stream=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText, sessionCode }),
      });
      if (!res.ok) throw new Error((await res.json()).error);

      await readSSEStream(res.body!.getReader(), (msg) => {
        switch (msg.type) {
          case "status": setParseStatus(msg.message); break;
          case "chunk": setStreamContent((prev) => prev + msg.content); break;
          case "result":
            setDraftId(msg.draftId);
            setParsedResult(msg.parsedResult);
            setReviewResult(msg.reviewResult);
            setCorrections(msg.corrections || []);
            setStatus("解析完成，请确认结构化记录。");
            break;
          case "error": throw new Error(msg.message);
        }
      });
    } catch (e: any) {
      setError(e.message || "解析失败");
    } finally {
      setParsing(false);
    }
  }

  async function handleConfirm() {
    if (!draftId) return;
    setConfirming(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId, action: "confirm", edits: parsedResult }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.warnings?.length) alert("⚠ " + data.warnings.join("\n"));
      setConfirmed(true);
      setStatus("课堂记录已写入，反馈上下文已刷新。");
      setContextReloadKey((current) => current + 1);
      setFeedbackCards([]);
      setFeedbackDirty(false);
      setForceRegenerate(true);
    } catch (e: any) {
      setError(e.message || "确认写入失败");
    } finally {
      setConfirming(false);
    }
  }

  async function handleGenerate() {
    if (!sessionCode) { setError("请先选择课次"); return; }
    setGenerating(true);
    setError("");
    setStatus("");
    setFeedbackCards([]);
    setFeedbackDone(0);
    setFeedbackDirty(false);

    try {
      const res = await fetch("/api/report/feedback-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionCode, historyModule: "feedback", bypassCache: forceRegenerate }),
      });
      if (!res.ok) throw new Error((await res.json()).error);

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await res.json();
        setFeedbackCards(data.students || []);
        setFeedbackTotal(data.total);
        setFeedbackDone(data.total);
        setStatus(data.cached ? "已恢复最近一次生成结果。" : "反馈已生成。");
        setForceRegenerate(false);
        return;
      }

      await readSSEStream(res.body!.getReader(), (msg) => {
        if (msg.type === "init") {
          setFeedbackTotal(msg.total);
          setFeedbackCards(msg.students);
        } else if (msg.type === "progress") {
          setFeedbackDone((prev) => prev + 1);
          setFeedbackCards((prev) =>
            prev.map((card) => card.id === msg.studentId ? { ...card, feedback: msg.feedback } : card)
          );
        } else if (msg.type === "done") {
          setFeedbackCards(msg.students || []);
          setFeedbackTotal(msg.total);
          setFeedbackDone(msg.total);
          setStatus("反馈已生成，可逐条编辑后导出。");
          setForceRegenerate(false);
        } else if (msg.type === "error") {
          throw new Error(msg.message || "批量生成失败");
        }
      });
    } catch (e: any) {
      setError(e.message || "批量生成失败");
    } finally {
      setGenerating(false);
    }
  }

  async function regenerateOne(studentId: string) {
    if (!sessionCode) return;
    const card = feedbackCards.find((item) => item.id === studentId);
    if (!card) return;
    setRegeneratingId(studentId);
    setError("");
    try {
      const res = await fetch("/api/report/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, sessionCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "重新生成失败");
      setFeedbackCards((current) => current.map((item) =>
        item.id === studentId ? { ...item, feedback: data.feedback || "" } : item
      ));
      setFeedbackDirty(true);
    } catch (e: any) {
      setError(e.message || "重新生成失败");
    } finally {
      setRegeneratingId("");
    }
  }

  function updateFeedback(studentId: string, feedback: string) {
    setFeedbackCards((current) => current.map((card) =>
      card.id === studentId ? { ...card, feedback } : card
    ));
    setFeedbackDirty(true);
  }

  async function saveFeedbackState() {
    if (!sessionCode || feedbackCards.length === 0) return;
    const res = await fetch("/api/report/feedback-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionCode,
        historyModule: "feedback",
        saveState: true,
        students: feedbackCards,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "保存反馈状态失败");
    setFeedbackDirty(false);
  }

  async function handleExport() {
    if (!sessionCode || feedbackCards.length === 0) return;
    setExporting(true);
    setError("");
    try {
      if (feedbackDirty) await saveFeedbackState();
      const a = document.createElement("a");
      a.href = `/api/report/feedback-batch?sessionCode=${sessionCode}&module=feedback`;
      a.download = `feedback_${sessionCode}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setStatus("已准备导出文件。");
    } catch (e: any) {
      setError(e.message || "导出失败");
    } finally {
      setExporting(false);
    }
  }

  function restoreHistory(state: FeedbackHistoryState) {
    setSemesterId(state.semesterId);
    setClassName(state.className);
    setSessionCode(state.sessionCode);
    setFeedbackCards(state.students);
    setFeedbackTotal(state.total);
    setFeedbackDone(state.total);
    setFeedbackDirty(false);
    setForceRegenerate(false);
    setContextReloadKey((current) => current + 1);
    setError("");
    setStatus("已恢复历史反馈结果。");
  }

  function markContextChanged() {
    setFeedbackCards([]);
    setFeedbackDone(0);
    setFeedbackTotal(0);
    setFeedbackDirty(false);
    setForceRegenerate(true);
    setContextReloadKey((current) => current + 1);
    setStatus("家校沟通已导入，反馈上下文已刷新。");
  }

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">课后反馈工作台</h2>
          <p className="text-sm text-gray-500 mt-1">选课次，准备上下文，写入课堂回顾，生成并导出家长反馈。</p>
        </div>
        <WorkHistoryButton<FeedbackHistoryState> module="feedback" onRestore={restoreHistory} />
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-gray-800">当前课次</h3>
            <p className="text-xs text-gray-500 mt-1">所有录入、上下文和反馈都围绕这里选中的课次。</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className={`rounded border px-2 py-1 ${statusTone(Boolean(sessionCode))}`}>课次</span>
            <span className={`rounded border px-2 py-1 ${statusTone(Boolean(parsedResult))}`}>解析</span>
            <span className={`rounded border px-2 py-1 ${statusTone(confirmed)}`}>写入</span>
            <span className={`rounded border px-2 py-1 ${statusTone(feedbackCards.length > 0)}`}>反馈</span>
          </div>
        </div>
        <SemesterPicker
          semesterId={semesterId}
          onSemesterChange={onSemIdChange}
          className={className}
          onClassChange={onClsChange}
          sessionCode={sessionCode}
          onSessionChange={onSessionChange}
        />
      </section>

      {error && <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}
      {status && <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">{status}</div>}

      <div className="grid gap-5 xl:grid-cols-[minmax(280px,0.92fr)_minmax(360px,1.08fr)_minmax(360px,1.1fr)]">
        <div className="space-y-5">
          <WeComWorkflowPanel
            title="家校沟通准备"
            description="同步、提取、预览并导入会影响本次反馈的家校沟通。"
            onApplied={markContextChanged}
          />
          <FeedbackContextPreview
            students={contextStudents}
            loading={contextLoading}
            error={contextError}
          />
        </div>

        <div className="space-y-5">
          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-gray-800">课堂回顾</h3>
                <p className="text-sm text-gray-500 mt-1">可直接粘贴文本，也可以从录音转写页送入。</p>
              </div>
              <a href="/diarize" className="text-sm text-blue-600 hover:text-blue-700">录音转写</a>
            </div>

            {parseStatus && !parsing && (
              <div className="mb-3 rounded-md border border-green-100 bg-green-50 px-3 py-2 text-sm text-green-700">
                {parseStatus}
              </div>
            )}

            <textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="写下这节课对反馈有用的事实。未提及学生会按缺勤补齐。"
              className="min-h-[180px] w-full resize-y rounded-lg border border-gray-300 p-4 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-xs text-gray-400">{rawText.length} 字</span>
              <button
                onClick={handleParse}
                disabled={!canParse}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {parsing ? (parseStatus || "解析中...") : "解析课堂回顾"}
              </button>
            </div>

            {parsing && streamContent && (
              <div className="mt-4 max-h-[180px] overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-3">
                <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-500">{streamContent}</p>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-gray-800">结构化记录确认</h3>
                <p className="text-sm text-gray-500 mt-1">确认后才会写入评价、考勤、事件和沟通。</p>
              </div>
              <button
                onClick={handleConfirm}
                disabled={!canConfirm}
                className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {confirming ? "写入中..." : confirmed ? "已写入" : "确认写入"}
              </button>
            </div>

            {corrections.length > 0 && (
              <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
                <span className="font-semibold text-blue-700">已自动修正姓名：</span>
                <div className="mt-1.5 space-y-1">
                  {corrections.map((item, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-gray-400 line-through">{item.original}</span>
                      <span className="text-gray-300">→</span>
                      <span className="font-medium text-blue-700">{item.corrected}</span>
                      <span className="rounded bg-white px-1.5 py-0.5 text-[10px] text-gray-500">{item.confidence}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {reviewResult && !reviewResult.is_valid && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                自审发现 {reviewResult.issues.length} 个问题：{reviewResult.issues.join("；")}
              </div>
            )}

            {!parsedResult ? (
              <div className="rounded-lg border border-dashed border-gray-200 p-8 text-center text-sm text-gray-400">
                解析课堂回顾后，学生记录会显示在这里。
              </div>
            ) : (
              <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1">
                {parsedResult.students.map((student: ParsedStudent, index: number) => (
                  <div key={`${student.name}-${index}`} className="rounded-lg border border-gray-100 p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="font-semibold text-gray-800">{student.name}</span>
                      {typeof student.present === "boolean" && (
                        <div className="ml-auto flex overflow-hidden rounded-lg border border-gray-300">
                          <button
                            type="button"
                            onClick={() => setParsedAttendance(index, true)}
                            className={`px-2.5 py-1 text-xs ${student.present ? "bg-green-600 text-white" : "bg-white text-gray-500"}`}
                          >
                            出勤
                          </button>
                          <button
                            type="button"
                            onClick={() => setParsedAttendance(index, false)}
                            className={`px-2.5 py-1 text-xs ${!student.present ? "bg-red-600 text-white" : "bg-white text-gray-500"}`}
                          >
                            缺勤
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-4 text-sm">
                      {(["A", "B", "C"] as const).map((dim) => (
                        <span key={dim}>
                          <span className="text-gray-400">{dimLabel[dim]}：</span>
                          <span className="font-mono font-medium">{student.scores[dim] != null ? `${student.scores[dim]} 分` : "—"}</span>
                        </span>
                      ))}
                    </div>
                    {student.events && student.events.length > 0 && (
                      <div className="mt-1 text-xs text-gray-500">{student.events.join("、")}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <section className="rounded-lg border border-gray-200 bg-white p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-800">反馈生成与导出</h3>
              <p className="text-sm text-gray-500 mt-1">生成后可逐条修改，导出会使用最终文本。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {generating ? `生成中 ${feedbackDone}/${feedbackTotal}` : "批量生成"}
              </button>
              <button
                onClick={handleExport}
                disabled={exporting || feedbackCards.length === 0}
                className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
              >
                {exporting ? "导出中..." : "导出 Excel"}
              </button>
            </div>
          </div>

          {feedbackCards.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-200 p-10 text-center text-sm text-gray-400">
              选择课次并生成后，每个学生的反馈卡片会显示在这里。
            </div>
          ) : (
            <div className="max-h-[760px] space-y-3 overflow-y-auto pr-1">
              {feedbackCards.map((card) => {
                const context = contextByStudent.get(card.id);
                return (
                  <div key={card.id} className="rounded-lg border border-gray-200 p-4">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-gray-800">{card.name}</span>
                      {(context?.labels.length ? context.labels : card.labels).map((label) => (
                        <span key={label} className="rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">{label}</span>
                      ))}
                    </div>
                    {context && (
                      <div className="mb-3 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-500">
                        {context.preview.today.slice(0, 2).join("；")}
                        {context.preview.communications.length > 0 ? `；${context.preview.communications[0]}` : ""}
                      </div>
                    )}
                    <textarea
                      value={card.feedback}
                      onChange={(e) => updateFeedback(card.id, e.target.value)}
                      className="min-h-[110px] w-full resize-y rounded-md border border-gray-300 px-3 py-2 text-sm leading-6 text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard?.writeText(card.feedback)}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
                      >
                        复制
                      </button>
                      <button
                        type="button"
                        onClick={() => void regenerateOne(card.id)}
                        disabled={regeneratingId === card.id}
                        className="rounded-md border border-amber-200 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                      >
                        {regeneratingId === card.id ? "生成中..." : "单独重写"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
