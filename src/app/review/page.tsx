"use client";

import { useState, useEffect } from "react";
import { DIM_LABEL } from "@/lib/constants";

interface Draft {
  id: string;
  rawText: string;
  parsedResult: {
    students: {
      name: string;
      scores: { A: number | null; B: number | null; C: number | null };
      events: string[];
      communication: { type: string; summary: string } | null;
    }[];
    alert_suggestion: string;
  };
  reviewResult: {
    is_valid: boolean;
    issues: string[];
    suggestions: string[];
    revised_scores: Record<string, any>;
    revised_events: Record<string, string[]>;
  } | null;
  status: string;
  sessionCode?: string | null;  // v0.7
  createdAt: string;
}

export default function ReviewPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<"pending" | "confirmed" | "rejected">("pending");
  const [filterClass, setFilterClass] = useState("");
  const [classes, setClasses] = useState<string[]>([]);

  // Editable state
  const [edits, setEdits] = useState<Record<string, any>>({});

  useEffect(() => {
    // Load class list
    fetch("/api/students")
      .then((r) => r.json())
      .then((students: { class: string }[]) =>
        setClasses([...new Set(students.map((s) => s.class))])
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchDrafts(filterStatus, filterClass);
  }, [filterStatus, filterClass]);

  async function fetchDrafts(status: string, className?: string) {
    try {
      const params = new URLSearchParams({ status });
      if (className) params.set("className", className);
      const res = await fetch(`/api/review?${params}`);
      const data = await res.json();
      setDrafts(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function startEdit(draft: Draft) {
    setEdits((prev) => ({
      ...prev,
      [draft.id]: structuredClone(draft.parsedResult),
    }));
    setExpandedId(draft.id);
  }

  function updateScore(draftId: string, studentIdx: number, dim: string, value: number) {
    setEdits((prev) => {
      const draftEdits = prev[draftId] || { students: [] };
      const students = [...draftEdits.students];
      if (students[studentIdx]) {
        students[studentIdx] = {
          ...students[studentIdx],
          scores: {
            ...students[studentIdx].scores,
            [dim]: value,
          },
        };
      }
      return { ...prev, [draftId]: { ...draftEdits, students } };
    });
  }

  function removeEvent(draftId: string, studentIdx: number, eventIdx: number) {
    setEdits((prev) => {
      const draftEdits = prev[draftId] || { students: [] };
      const students = [...draftEdits.students];
      if (students[studentIdx]) {
        students[studentIdx] = {
          ...students[studentIdx],
          events: students[studentIdx].events.filter(
            (_: string, i: number) => i !== eventIdx
          ),
        };
      }
      return { ...prev, [draftId]: { ...draftEdits, students } };
    });
  }

  async function handleAction(draftId: string, action: "confirm" | "reject") {
    setProcessingId(draftId);
    try {
      const body: any = { draftId, action };
      if (action === "confirm" && edits[draftId]) {
        body.edits = edits[draftId];
      }

      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "操作失败");
      }

      // v0.11.4: 显示 warnings（无课次导致 Event/Comm 被跳过）
      const data = await res.json();
      if (data.warnings && data.warnings.length > 0) {
        alert("⚠ 注意：\n" + data.warnings.join("\n"));
      }

      fetchDrafts(filterStatus, filterClass);
      setExpandedId(null);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setProcessingId(null);
    }
  }

  /** v0.5.1: Get review info for a specific student */
  function studentReview(draft: Draft, studentName: string) {
    if (!draft.reviewResult) return null;
    const revisedScores = draft.reviewResult.revised_scores?.[studentName];
    const revisedEvents = draft.reviewResult.revised_events?.[studentName];
    if (!revisedScores && !revisedEvents) return null;
    return { revisedScores, revisedEvents };
  }

  /** Count students with review issues */
  function reviewedStudentCount(draft: Draft): number {
    if (!draft.reviewResult) return 0;
    const names = new Set([
      ...Object.keys(draft.reviewResult.revised_scores || {}),
      ...Object.keys(draft.reviewResult.revised_events || {}),
    ]);
    return names.size;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-2">复核中心</h2>
      <p className="text-sm text-gray-500 mb-4">
        审核 LLM 生成的草案，确认后写入数据库。
      </p>

      {/* 筛选栏 */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        {(["pending", "confirmed", "rejected"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              filterStatus === s
                ? "bg-blue-600 text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            {s === "pending" ? "待复核" : s === "confirmed" ? "已确认" : "已放弃"}
          </button>
        ))}
        {/* v0.12: 按班级筛选 */}
        <span className="text-xs text-gray-400 ml-auto">班级</span>
        <select
          value={filterClass}
          onChange={(e) => setFilterClass(e.target.value)}
          className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm outline-none"
        >
          <option value="">全部</option>
          {classes.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="text-center py-20 text-gray-400">
          <div className="animate-spin h-8 w-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-3" />
          加载中...
        </div>
      )}

      {!loading && drafts.length === 0 && (
        <div className="text-center py-20 text-gray-400">
          <p className="text-4xl mb-3">{filterStatus === "pending" ? "✅" : "📭"}</p>
          <p>
            {filterStatus === "pending" ? "没有待复核的记录"
              : filterStatus === "confirmed" ? "没有已确认的记录"
              : "没有已放弃的记录"}
          </p>
        </div>
      )}

      <div className="space-y-4">
        {drafts.map((draft) => {
          const isExpanded = expandedId === draft.id;
          const currentData = edits[draft.id] || draft.parsedResult;
          const isProcessing = processingId === draft.id;

          return (
            <div
              key={draft.id}
              className="bg-white border border-gray-200 rounded-lg overflow-hidden"
            >
              {/* Header */}
              <div
                className="p-4 cursor-pointer hover:bg-gray-50"
                onClick={() =>
                  isExpanded
                    ? setExpandedId(null)
                    : startEdit(draft)
                }
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <p className="text-sm text-gray-800 line-clamp-2">
                      {draft.rawText}
                    </p>
                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                      <span>
                        {new Date(draft.createdAt).toLocaleString("zh-CN")}
                      </span>
                      <span>
                        {draft.parsedResult.students.length} 名学生
                      </span>
                      {draft.sessionCode && (
                        <span className="text-blue-500 font-mono">{draft.sessionCode}</span>
                      )}
                      {draft.reviewResult && (
                        <span
                          className={
                            draft.reviewResult.is_valid
                              ? "text-green-500"
                              : `text-amber-500 font-medium`
                          }
                        >
                          {draft.reviewResult.is_valid
                            ? "✓ 自审通过"
                            : `⚠ ${draft.reviewResult.issues.length} 个问题 · ${reviewedStudentCount(draft)} 名学生需关注`}
                        </span>
                      )}
                      {!draft.reviewResult && (
                        <span className="text-gray-400">无自审结果</span>
                      )}
                    </div>
                  </div>
                  <span className="text-gray-400 text-sm">
                    {isExpanded ? "收起 ▲" : "展开 ▼"}
                  </span>
                </div>
              </div>

              {/* Expanded Content */}
              {isExpanded && (
                <div className="border-t border-gray-100 p-4 bg-gray-50">
                  {/* v0.5.1: Compact self-review overview */}
                  {draft.reviewResult && (
                    <div className={`rounded-lg p-3 mb-4 ${
                      draft.reviewResult.is_valid
                        ? "bg-green-50 border border-green-200"
                        : "bg-amber-50 border border-amber-200"
                    }`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold">
                          {draft.reviewResult.is_valid ? "✅" : "⚠️"} 自审总览
                        </span>
                        {!draft.reviewResult.is_valid && (
                          <span className="text-xs text-amber-600">
                            {draft.reviewResult.issues.length} 问题 · {draft.reviewResult.suggestions.length} 建议 · {reviewedStudentCount(draft)} 名学生需关注
                          </span>
                        )}
                      </div>
                      {draft.reviewResult.issues.length > 0 && (
                        <details className="mt-1">
                          <summary className="text-xs text-amber-700 cursor-pointer hover:text-amber-800">查看详情</summary>
                          <ul className="list-disc list-inside text-xs text-amber-700 mt-1 space-y-0.5">
                            {draft.reviewResult.issues.map((issue, i) => (<li key={i}>{issue}</li>))}
                            {draft.reviewResult.suggestions.map((s, i) => (<li key={`s${i}`}>💡 {s}</li>))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}

                  {/* Student Cards with review highlights */}
                  {currentData.students.map((stu: any, si: number) => {
                    const review = studentReview(draft, stu.name);
                    const hasIssue = review !== null;
                    return (
                    <div key={si} className={`bg-white border rounded-lg p-4 mb-3 transition-colors ${
                      hasIssue ? "border-amber-300 bg-amber-50/30 shadow-sm" : "border-gray-200"
                    }`}>
                      <div className="flex items-center gap-2 mb-3">
                        <h5 className="font-semibold text-gray-800">👤 {stu.name}</h5>
                        {hasIssue && <span className="text-xs bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded font-medium">⚠ 需关注</span>}
                      </div>

                      {/* Review suggestions for this specific student */}
                      {review && (
                        <div className="bg-amber-50 border border-amber-100 rounded p-2 mb-3">
                          {review.revisedScores && (
                            <div className="text-xs text-amber-700 mb-1">
                              💡 建议调整：
                              {Object.entries(review.revisedScores as Record<string,number|null>).filter(([, v]) => v != null).map(([dim, val]) => (
                                <span key={dim} className="font-mono font-medium ml-1">{DIM_LABEL[dim]||dim}→{val}分</span>
                              ))}
                            </div>
                          )}
                          {review.revisedEvents?.length > 0 && (
                            <div className="text-xs text-amber-700">📝 建议事件：{review.revisedEvents.join("、")}</div>
                          )}
                        </div>
                      )}

                      {/* Scores */}
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        {(["A","B","C"] as const).map((dim) => {
                          const suggested = review?.revisedScores?.[dim];
                          return (
                          <div key={dim}>
                            <label className={`text-xs block mb-1 ${suggested!=null?"text-amber-600 font-medium":"text-gray-500"}`}>
                              {DIM_LABEL[dim]}{suggested!=null?` →${suggested}`:""}
                            </label>
                            <select value={stu.scores[dim]??""} onChange={(e)=>updateScore(draft.id,si,dim,e.target.value===""?null!:Number(e.target.value))}
                              className={`w-full border rounded px-2 py-1.5 text-sm ${suggested!=null?"border-amber-300 bg-amber-50":"border-gray-300"}`}>
                              <option value="">未提及</option>
                              {[0,1,2,3,4,5].map(n=><option key={n} value={n}>{n}分</option>)}
                            </select>
                          </div>);
                        })}
                      </div>

                      {/* Events */}
                      <div>
                        <span className="text-xs text-gray-500">事件：</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {stu.events?.map((event:string,ei:number)=>{
                            const isRevised=review?.revisedEvents?.includes(event);
                            return (<span key={ei} className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded ${isRevised?"bg-amber-100 text-amber-700 border border-amber-200":"bg-blue-50 text-blue-700"}`}>
                              {event}<button onClick={()=>removeEvent(draft.id,si,ei)} className="hover:text-red-500">×</button></span>);
                          })}
                          {review?.revisedEvents?.filter((ev:string)=>!stu.events?.includes(ev)).map((ev:string,i:number)=>(
                            <span key={`new${i}`} className="inline-flex items-center gap-1 text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded">+ {ev}</span>
                          ))}
                        </div>
                      </div>

                      {/* Communication */}
                      {stu.communication && (
                        <div className="bg-purple-50 rounded p-2 mt-2">
                          <span className="text-xs font-medium text-purple-700">📞 家校沟通</span>
                          <p className="text-xs text-purple-600 mt-0.5">{stu.communication.summary}</p>
                        </div>
                      )}
                    </div>);
                  })}

                  {/* Alert */}
                  {currentData.alert_suggestion && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                      <span className="text-xs font-semibold text-red-700">🚨 {currentData.alert_suggestion}</span>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex gap-3">
                    <button onClick={()=>handleAction(draft.id,"reject")} disabled={isProcessing}
                      className="flex-1 py-2.5 border border-gray-300 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-100 disabled:opacity-50">
                      {isProcessing?"处理中...":"✕ 放弃"}</button>
                    <button onClick={()=>handleAction(draft.id,"confirm")} disabled={isProcessing}
                      className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                      {isProcessing?"处理中...":"✓ 确认写入"}</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
