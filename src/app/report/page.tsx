"use client";

import { useState, useEffect } from "react";

interface StudentCard {
  id: string;
  name: string;
  labels: string[];
  feedback?: string;
}

export default function ReportPage() {
  const [semesters, setSemesters] = useState<{ id: string; name: string }[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [students, setStudents] = useState<{ id: string; name: string; class: string }[]>([]);
  const [selectedSemesterId, setSelectedSemesterId] = useState("");
  const [selectedClass, setSelectedClass] = useState("");

  // Daily report — session-based
  const [sessions, setSessions] = useState<{ code: string; semesterNumber: number; date: string }[]>([]);
  const [selectedSessionCode, setSelectedSessionCode] = useState("");
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyReport, setDailyReport] = useState("");

  // Batch feedback
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchCached, setBatchCached] = useState(false);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchCards, setBatchCards] = useState<StudentCard[]>([]);
  const [batchDoneCount, setBatchDoneCount] = useState(0);

  // Feedback
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [feedbackSessionCode, setFeedbackSessionCode] = useState("");
  const [feedbackDays, setFeedbackDays] = useState(14);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");

  useEffect(() => {
    fetch("/api/semesters").then((r) => r.json()).then(setSemesters);
    fetch("/api/students").then((r) => r.json()).then((ss: any[]) => {
      setClasses([...new Set(ss.map((s: any) => s.class))]);
      setStudents(ss);
    });
  }, []);

  useEffect(() => {
    if (!selectedSemesterId || !selectedClass) { setSessions([]); return; }
    fetch(`/api/sessions?semesterId=${selectedSemesterId}&className=${encodeURIComponent(selectedClass)}`)
      .then((r) => r.json()).then(setSessions);
  }, [selectedSemesterId, selectedClass]);

  async function generateDaily() {
    if (!selectedSessionCode) return;
    setDailyLoading(true);
    try {
      const res = await fetch("/api/report/daily", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionCode: selectedSessionCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDailyReport(data.report);
    } catch (e: any) { alert(e.message); }
    finally { setDailyLoading(false); }
  }

  // Reset cache when session changes
  function onSessionChange(code: string) {
    setSelectedSessionCode(code);
    setBatchCached(false);
    setBatchTotal(0);
    setBatchCards([]);
    setBatchDoneCount(0);
  }

  async function handleBatchFeedback() {
    if (!selectedSessionCode) return;
    setBatchLoading(true);
    setBatchCached(false);
    setBatchCards([]);
    setBatchDoneCount(0);

    try {
      const res = await fetch("/api/report/feedback-batch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionCode: selectedSessionCode }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "请求失败");
      }

      // If cached, returns JSON directly (no SSE)
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await res.json();
        setBatchCached(true);
        setBatchTotal(data.total);
        setBatchLoading(false);
        return;
      }

      // SSE stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (value) {
            buffer += decoder.decode(value, { stream: !done });
          }

          if (done) {
            // Flush decoder: finalize any pending multi-byte sequences
            buffer += decoder.decode();
            // Process remaining buffer (last SSE message)
            if (buffer.trim()) {
              const line = buffer.trim();
              if (line.startsWith("data:")) {
                try {
                  handleSSEEvent(JSON.parse(line.slice(5)));
                } catch { /* skip */ }
              }
            }
            break;
          }

          // Extract complete SSE messages (delimited by \n\n)
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const part = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (!part.startsWith("data:")) continue;
            try {
              handleSSEEvent(JSON.parse(part.slice(5)));
            } catch { /* skip */ }
          }
        }
      } finally {
        reader.releaseLock();
      }

      setBatchLoading(false);
    } catch (e: any) {
      alert(e.message);
      setBatchLoading(false);
    }
  }

  function handleSSEEvent(data: any) {
    switch (data.type) {
      case "init":
        setBatchCards(data.students.map((s: any) => ({
          id: s.id, name: s.name, labels: s.labels,
        })));
        setBatchTotal(data.total);
        break;
      case "progress":
        setBatchCards(prev => prev.map(c =>
          c.id === data.studentId ? { ...c, feedback: data.feedback } : c
        ));
        setBatchDoneCount(prev => prev + 1);
        break;
      case "done":
        setBatchCached(true);
        setBatchTotal(data.total);
        break;
    }
  }

  function downloadBatchExcel() {
    if (!selectedSessionCode) return;
    const a = document.createElement("a");
    a.href = `/api/report/feedback-batch?sessionCode=${selectedSessionCode}`;
    a.download = `反馈_${selectedClass}_${selectedSessionCode}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function generateFeedback() {
    if (!selectedStudentId) return;
    setFeedbackLoading(true);
    try {
      const body: any = { studentId: selectedStudentId };
      if (feedbackSessionCode) {
        body.sessionCode = feedbackSessionCode;
      } else {
        body.days = feedbackDays;
      }
      const res = await fetch("/api/report/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFeedbackText(data.feedback);
    } catch (e: any) { alert(e.message); }
    finally { setFeedbackLoading(false); }
  }

  const labelColors = [
    "bg-blue-100 text-blue-700",
    "bg-green-100 text-green-700",
    "bg-purple-100 text-purple-700",
    "bg-amber-100 text-amber-700",
    "bg-pink-100 text-pink-700",
    "bg-cyan-100 text-cyan-700",
    "bg-red-100 text-red-700",
  ];

  return (
    <div className="max-w-5xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-2">报告生成</h2>
      <p className="text-sm text-gray-500 mb-6">AI 生成班级日报和家校反馈文本。</p>

      <div className="flex items-center gap-3 mb-8 flex-wrap">
        <select value={selectedSemesterId} onChange={(e) => { setSelectedSemesterId(e.target.value); setSelectedClass(""); }}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none">
          <option value="">选择学期</option>
          {semesters.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
        </select>
        {selectedSemesterId && (
          <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none">
            <option value="">选择班级</option>
            {classes.map((c) => (<option key={c} value={c}>{c}</option>))}
          </select>
        )}
      </div>

      {/* Daily Report — by session */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-3">📰 班级日报</h3>
        {selectedClass && sessions.length > 0 && (
          <div className="flex items-center gap-3 mb-4">
            <select value={selectedSessionCode} onChange={(e) => onSessionChange(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono outline-none">
              <option value="">选择课次</option>
              {sessions.map((s) => (
                <option key={s.code} value={s.code}>{s.code} — 第{s.semesterNumber}次课 ({s.date})</option>
              ))}
            </select>
            <button onClick={generateDaily} disabled={dailyLoading || !selectedSessionCode}
              className="bg-blue-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {dailyLoading ? "生成中..." : "生成日报"}
            </button>
            {!batchCached && (
              <button onClick={handleBatchFeedback} disabled={batchLoading || !selectedSessionCode}
                className="bg-purple-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50">
                {batchLoading ? `生成中...（${batchDoneCount}/${batchTotal}）` : "批量反馈 → Excel"}
              </button>
            )}
            {batchCached && (
              <button onClick={downloadBatchExcel}
                className="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-700">
                📥 下载 Excel（{batchTotal}人，30分钟内有效）
              </button>
            )}
          </div>
        )}
        {!selectedClass && <p className="text-sm text-gray-400 mb-4">请先选择学期和班级</p>}
        {dailyReport && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
            {dailyReport}
          </div>
        )}

        {/* Student Feedback Cards Grid */}
        {batchCards.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center gap-2 mb-3">
              <h4 className="text-sm font-semibold text-gray-700">
                🏷️ 学生反馈标签卡
              </h4>
              {batchLoading && (
                <span className="text-xs text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">
                  {batchDoneCount}/{batchTotal}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {batchCards.map((card) => (
                <div
                  key={card.id}
                  className={`rounded-xl border p-3 transition-all duration-300 ${
                    card.feedback
                      ? "bg-white border-gray-200 shadow-sm"
                      : "bg-gray-50 border-gray-200 animate-pulse"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="w-6 h-6 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                      {card.name.charAt(0)}
                    </div>
                    <span className="text-sm font-semibold text-gray-800 truncate">
                      {card.name}
                    </span>
                  </div>

                  {/* Labels */}
                  {card.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {card.labels.map((label, i) => (
                        <span
                          key={label}
                          className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                            labelColors[i % labelColors.length]
                          }`}
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Feedback */}
                  {card.feedback ? (
                    <p className="text-xs text-gray-600 leading-relaxed">
                      {card.feedback}
                    </p>
                  ) : (
                    <div className="text-xs text-gray-400 italic mt-1">
                      等待生成...
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Feedback */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-3">💬 家校反馈</h3>
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <select value={selectedStudentId} onChange={(e) => setSelectedStudentId(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none">
            <option value="">选择学生</option>
            {students.filter((s) => !selectedClass || s.class === selectedClass).map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.class})</option>
            ))}
          </select>
          {selectedClass && sessions.length > 0 && (
            <select value={feedbackSessionCode} onChange={(e) => { setFeedbackSessionCode(e.target.value); setFeedbackDays(14); }}
              className="border border-blue-300 rounded-lg px-3 py-2 text-sm font-mono outline-none bg-blue-50">
              <option value="">按课次（推荐）</option>
              {sessions.map((s) => (
                <option key={s.code} value={s.code}>{s.code} — 第{s.semesterNumber}次课</option>
              ))}
            </select>
          )}
          {!feedbackSessionCode && (
            <select value={feedbackDays} onChange={(e) => setFeedbackDays(Number(e.target.value))}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none">
              <option value={7}>近 7 天</option>
              <option value={14}>近 14 天</option>
              <option value={30}>近 30 天</option>
            </select>
          )}
          <button onClick={generateFeedback} disabled={feedbackLoading || !selectedStudentId}
            className="bg-green-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
            {feedbackLoading ? "生成中..." : "生成反馈"}
          </button>
        </div>
        {feedbackText && (
          <div className="bg-green-50 border border-green-100 rounded-lg p-4 text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
            {feedbackText}
          </div>
        )}
      </div>
    </div>
  );
}
