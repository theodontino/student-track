"use client";

import { useEffect, useState } from "react";
import SemesterPicker from "@/components/SemesterPicker";
import { readSSEStream } from "@/lib/sse";
import WorkHistoryButton from "@/components/WorkHistoryButton";
import FeedbackContextPreview from "@/components/FeedbackContextPreview";
import WeComWorkflowPanel from "@/components/wecom/WeComWorkflowPanel";
import type { FeedbackContextStudent } from "@/components/wecom/types";

interface FeedbackCard { id: string; name: string; labels: string[]; feedback: string; }
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

const STEPS = [
  { num: 1, label: "回顾" }, { num: 2, label: "确认" },
  { num: 3, label: "反馈" }, { num: 4, label: "导出" },
];

export default function FeedbackWizardPage() {
  const [step, setStep] = useState(1);
  const [semesterId, setSemesterId] = useState("");
  const [className, setClassName] = useState("");
  const [sessionCode, setSessionCode] = useState("");
  const [rawText, setRawText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState("");
  const [streamContent, setStreamContent] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  // Step 2 state
  const [draftId, setDraftId] = useState("");
  const [parsedResult, setParsedResult] = useState<any>(null);
  const [reviewResult, setReviewResult] = useState<any>(null);
  const [corrections, setCorrections] = useState<any[]>([]);

  // Step 3 state
  const [feedbackCards, setFeedbackCards] = useState<FeedbackCard[]>([]);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackDone, setFeedbackDone] = useState(0);
  const [contextStudents, setContextStudents] = useState<FeedbackContextStudent[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [contextReloadKey, setContextReloadKey] = useState(0);

  useEffect(() => {
    const draft = sessionStorage.getItem("chem-track:feedback-draft");
    if (!draft) return;
    setRawText(draft);
    setParseStatus("已从录音转写载入课后回顾。");
    sessionStorage.removeItem("chem-track:feedback-draft");
  }, []);

  useEffect(() => {
    if (step !== 3 || !sessionCode) return;
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
  }, [step, sessionCode, contextReloadKey]);

  function onSemIdChange(id: string) { setSemesterId(id); setClassName(""); setSessionCode(""); }
  function onClsChange(cls: string) { setClassName(cls); setSessionCode(""); }

  function setParsedAttendance(index: number, present: boolean) {
    setParsedResult((current: any) => current ? {
      ...current,
      students: current.students.map((student: any, studentIndex: number) =>
        studentIndex === index ? { ...student, present } : student
      ),
    } : current);
  }

  // Step 1: parse NL input (SSE streaming)
  async function handleParse() {
    if (!rawText.trim()) { setError("请输入文本"); return; }
    if (!sessionCode) { setError("请选择课次，未提及学生将按缺勤处理"); return; }
    setParsing(true); setError("");
    try {
      const res = await fetch("/api/input/parse?stream=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText, sessionCode: sessionCode || undefined }),
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
            setStep(2);
            break;
          case "error": throw new Error(msg.message);
        }
      });
    } catch (e: any) { setError(e.message); }
    finally { setParsing(false); }
  }

  // Step 2: confirm draft write
  async function handleConfirm() {
    if (!draftId) return;
    setConfirming(true); setError("");
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId, action: "confirm", edits: parsedResult }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.warnings?.length) alert("⚠ " + data.warnings.join("\n"));
      setStep(3);
    } catch (e: any) { setError(e.message); }
    finally { setConfirming(false); }
  }

  // Step 3: generate batch feedback via SSE
  async function handleGenerate() {
    if (!sessionCode) { setError("请先在步骤1选择课次"); return; }
    setGenerating(true); setError("");
    setFeedbackCards([]); setFeedbackDone(0);

    try {
      const res = await fetch("/api/report/feedback-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionCode, historyModule: "feedback", bypassCache: contextReloadKey > 0 }),
      });
      if (!res.ok) throw new Error((await res.json()).error);

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await res.json();
        setFeedbackCards(data.students || []);
        setFeedbackTotal(data.total);
        setFeedbackDone(data.total);
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
        } else if (msg.type === "error") {
          throw new Error(msg.message || "批量生成失败");
        }
      });
    } catch (e: any) { setError(e.message); }
    finally { setGenerating(false); }
  }

  // Step 4: download cached feedback Excel
  function handleExport() {
    if (!sessionCode) return;
    const a = document.createElement("a");
    a.href = `/api/report/feedback-batch?sessionCode=${sessionCode}&module=feedback`;
    a.download = `feedback_${sessionCode}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const dimLabel: Record<string, string> = { A: "学习", B: "纪律", C: "作业" };

  function restoreHistory(state: FeedbackHistoryState) {
    setSemesterId(state.semesterId);
    setClassName(state.className);
    setSessionCode(state.sessionCode);
    setFeedbackCards(state.students);
    setFeedbackTotal(state.total);
    setFeedbackDone(state.total);
    setContextStudents([]);
    setContextError("");
    setContextReloadKey(0);
    setStep(4);
    setError("");
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">🚀 课后反馈工作台</h2>
          <p className="text-sm text-gray-500 mt-1">选课次，放入老师课后回顾，确认后生成今晚可发的家长反馈。</p>
        </div>
        <WorkHistoryButton<FeedbackHistoryState> module="feedback" onRestore={restoreHistory} />
      </div>

      {/* Step Indicator */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((s, i) => (
          <div key={s.num} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
              step >= s.num ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-400"
            }`}>
              {s.num}
            </div>
            <span className={`text-sm ${step >= s.num ? "text-blue-600 font-medium" : "text-gray-400"}`}>
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <div className={`w-8 h-px ${step > s.num ? "bg-blue-400" : "bg-gray-200"}`} />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 text-sm rounded-lg">{error}</div>
      )}

      {/* Step 1: Input */}
      {step === 1 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h3 className="font-semibold text-gray-800">✏️ 课后回顾</h3>
              <p className="text-xs text-gray-500 mt-1">只写和学生反馈有关的事实，系统会把未提及学生按缺勤补齐。</p>
            </div>
            <a href="/diarize" className="text-sm text-blue-600 hover:text-blue-700 shrink-0">去转写录音</a>
          </div>

          {parseStatus && !parsing && (
            <div className="mb-4 rounded-lg border border-green-100 bg-green-50 px-3 py-2 text-sm text-green-700">
              {parseStatus}
            </div>
          )}

          <div className="mb-4">
            <SemesterPicker
              semesterId={semesterId}
              onSemesterChange={onSemIdChange}
              className={className}
              onClassChange={onClsChange}
              sessionCode={sessionCode}
              onSessionChange={setSessionCode}
            />
          </div>

          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="粘贴或从转写页送入课后回顾，如：今天是某班第几次课。张三听课状态不错，测验还可以，但作业订正不够主动。李四前半节有点走神，后半节跟上了，建议家长提醒复习氧化还原。"
            className="w-full border border-gray-300 rounded-lg p-4 text-sm min-h-[120px] outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          />

          <div className="flex items-center justify-between mt-4">
            <span className="text-xs text-gray-400">{rawText.length} 字</span>
            <button onClick={handleParse} disabled={parsing || !rawText.trim() || !sessionCode}
              className="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {parsing ? (parseStatus || "解析中…") : "① 解析 →"}
            </button>
          </div>

          {parsing && streamContent && (
            <div className="mt-4 bg-gray-50 border border-gray-200 rounded-lg p-3 max-h-[200px] overflow-y-auto">
              <p className="text-xs font-mono text-gray-500 whitespace-pre-wrap leading-relaxed">{streamContent}</p>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Review */}
      {step === 2 && parsedResult && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="font-semibold text-gray-800 mb-4">✅ 确认 LLM 解析结果</h3>

          {/* Name corrections highlight */}
          {corrections.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm">
              <span className="font-semibold text-blue-700">📝 已自动修正姓名：</span>
              <div className="space-y-1 mt-1.5">
                {corrections.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className="text-gray-400 line-through">{c.original}</span>
                    <span className="text-gray-300">→</span>
                    <span className="font-medium text-blue-700">{c.corrected}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      c.confidence === "high" ? "bg-green-100 text-green-700" :
                      c.confidence === "medium" ? "bg-yellow-100 text-yellow-700" :
                      "bg-red-100 text-red-700"
                    }`}>
                      {c.confidence === "high" ? "确信" : c.confidence === "medium" ? "较可能" : "存疑"}
                    </span>
                    <span className="text-gray-400">{c.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {reviewResult && !reviewResult.is_valid && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-sm">
              <span className="font-semibold text-amber-700">⚠ 自审发现 {reviewResult.issues.length} 个问题：</span>
              <ul className="list-disc list-inside text-amber-600 mt-1 text-xs">
                {reviewResult.issues.map((i: string, idx: number) => <li key={idx}>{i}</li>)}
              </ul>
              {reviewResult.name_issues?.length > 0 && (
                <div className="mt-2 pt-2 border-t border-amber-200">
                  <span className="text-xs font-semibold text-amber-700">👤 人名/事件对应问题：</span>
                  {reviewResult.name_issues.map((ni: any, idx: number) => (
                    <div key={idx} className="flex items-center gap-2 mt-1 text-xs">
                      <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${
                        ni.severity === "high" ? "bg-red-100 text-red-700" :
                        ni.severity === "medium" ? "bg-yellow-100 text-yellow-700" :
                        "bg-gray-100 text-gray-600"
                      }`}>
                        {ni.severity === "high" ? "🔴" : ni.severity === "medium" ? "🟡" : "⚪"}
                      </span>
                      <span className="text-amber-800">{ni.student}：</span>
                      <span className="text-amber-600">{ni.issue}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-3 mb-6">
            {parsedResult.students.map((stu: any, i: number) => (
              <div key={i} className="border border-gray-100 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-semibold text-gray-800">👤 {stu.name}</span>
                  {typeof stu.present === "boolean" && (
                    <div className="ml-auto flex border border-gray-300 rounded-lg overflow-hidden">
                      <button type="button" onClick={() => setParsedAttendance(i, true)} className={`px-2.5 py-1 text-xs ${stu.present ? "bg-green-600 text-white" : "bg-white text-gray-500"}`}>出勤</button>
                      <button type="button" onClick={() => setParsedAttendance(i, false)} className={`px-2.5 py-1 text-xs ${!stu.present ? "bg-red-600 text-white" : "bg-white text-gray-500"}`}>缺勤</button>
                    </div>
                  )}
                </div>
                <div className="flex gap-4 text-sm">
                  {(["A","B","C"] as const).map((dim) => (
                    <span key={dim}>
                      <span className="text-gray-400">{dimLabel[dim]}：</span>
                      <span className="font-mono font-medium">
                        {stu.scores[dim] != null ? `${stu.scores[dim]} 分` : "—"}
                      </span>
                    </span>
                  ))}
                </div>
                {stu.events?.length > 0 && (
                  <div className="text-xs text-gray-500 mt-1">📝 {stu.events.join("、")}</div>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <button onClick={() => setStep(1)}
              className="flex-1 py-2.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">
              ← 返回修改
            </button>
            <button onClick={handleConfirm} disabled={confirming}
              className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
              {confirming ? "写入中..." : "② 确认写入 →"}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Generate Feedback */}
      {step === 3 && (
        <div className="space-y-5">
          <div>
            <h3 className="font-semibold text-gray-800">📋 生成家长反馈</h3>
            <p className="text-sm text-gray-500 mt-1">先整理家校沟通上下文，再确认系统会参考什么，最后生成今晚可发的反馈。</p>
          </div>

          <WeComWorkflowPanel
            title="课前家校沟通准备"
            description="在工作台内同步、提取、预览并导入会影响本次反馈的家校沟通。"
            onApplied={() => {
              setFeedbackCards([]);
              setFeedbackDone(0);
              setFeedbackTotal(0);
              setContextReloadKey((current) => current + 1);
            }}
          />

          <FeedbackContextPreview
            students={contextStudents}
            loading={contextLoading}
            error={contextError}
          />

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            {feedbackCards.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-gray-400 mb-4">将为 {className} 通过 {sessionCode} 生成反馈</p>
                <button onClick={handleGenerate} disabled={generating}
                  className="bg-amber-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50">
                  {generating ? `生成中 ${feedbackDone}/${feedbackTotal}...` : "③ 生成 →"}
                </button>
              </div>
            ) : (
              <>
                {generating && (
                  <div className="text-sm text-amber-600 mb-4">
                    生成中 {feedbackDone}/{feedbackTotal}...
                  </div>
                )}
                <div className="space-y-2 mb-6 max-h-[400px] overflow-y-auto">
                  {feedbackCards.map((c, i) => (
                    <div key={i} className="border border-gray-100 rounded-lg p-3 text-sm">
                      <div className="font-medium text-gray-800 mb-1">{c.name}</div>
                      <div className="text-gray-600 whitespace-pre-wrap">{c.feedback || "待生成..."}</div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setStep(2)}
                    className="flex-1 py-2.5 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">
                    ← 返回
                  </button>
                  <button onClick={() => setStep(4)}
                    className="flex-1 py-2.5 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700">
                    ④ 下一步：导出 →
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Step 4: Export */}
      {step === 4 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
          <h3 className="font-semibold text-gray-800 mb-2">📥 导出 Excel</h3>
          <p className="text-sm text-gray-500 mb-6">
            反馈已生成，点击下载 Excel 文件归档。
          </p>
          <div className="flex gap-3 justify-center">
            <button onClick={() => setStep(3)}
              className="py-2.5 px-6 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">
              ← 返回
            </button>
            <button onClick={handleExport}
              className="bg-purple-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-purple-700">
              📥 下载 Excel
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
