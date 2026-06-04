"use client";

import { useState, useEffect } from "react";

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
  const [batchLoading, setBatchLoading] = useState(false);

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

  async function handleBatchFeedback() {
    if (!selectedSessionCode) return;
    setBatchLoading(true);
    try {
      const res = await fetch("/api/report/feedback-batch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionCode: selectedSessionCode }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
      const arr = await res.arrayBuffer();
      const blob = new Blob([arr], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `反馈_${selectedClass}_${selectedSessionCode}.xlsx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (e: any) { alert(e.message); }
    finally { setBatchLoading(false); }
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

  return (
    <div className="max-w-4xl mx-auto">
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
            <select value={selectedSessionCode} onChange={(e) => setSelectedSessionCode(e.target.value)}
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
            <button onClick={handleBatchFeedback} disabled={batchLoading || !selectedSessionCode}
              className="bg-purple-600 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50">
              {batchLoading ? "批量生成中..." : "批量反馈 → Excel"}
            </button>
          </div>
        )}
        {!selectedClass && <p className="text-sm text-gray-400 mb-4">请先选择学期和班级</p>}
        {dailyReport && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
            {dailyReport}
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
