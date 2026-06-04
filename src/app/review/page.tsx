"use client";

import { useState, useEffect } from "react";

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
  createdAt: string;
}

export default function ReviewPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Editable state
  const [edits, setEdits] = useState<Record<string, any>>({});

  useEffect(() => {
    fetchDrafts();
  }, []);

  async function fetchDrafts() {
    try {
      const res = await fetch("/api/review?status=pending");
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
      [draft.id]: JSON.parse(JSON.stringify(draft.parsedResult)),
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

      fetchDrafts();
      setExpandedId(null);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setProcessingId(null);
    }
  }

  const dimLabel: Record<string, string> = {
    A: "学习&测验",
    B: "精神&纪律",
    C: "课后任务",
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-2">复核中心</h2>
      <p className="text-sm text-gray-500 mb-6">
        审核 LLM 生成的草案，确认后写入数据库。
      </p>

      {loading && (
        <div className="text-center py-20 text-gray-400">
          <div className="animate-spin h-8 w-8 border-2 border-blue-600 border-t-transparent rounded-full mx-auto mb-3" />
          加载中...
        </div>
      )}

      {!loading && drafts.length === 0 && (
        <div className="text-center py-20 text-gray-400">
          <p className="text-4xl mb-3">✅</p>
          <p>没有待复核的记录</p>
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
                      {draft.reviewResult && (
                        <span
                          className={
                            draft.reviewResult.is_valid
                              ? "text-green-500"
                              : "text-amber-500"
                          }
                        >
                          {draft.reviewResult.is_valid
                            ? "LLM 自审通过"
                            : `${draft.reviewResult.issues.length} 个问题`}
                        </span>
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
                  {/* LLM Review */}
                  {draft.reviewResult && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                      <h4 className="text-sm font-semibold text-amber-800 mb-1">
                        🤖 LLM 自审意见
                      </h4>
                      {draft.reviewResult.issues.length > 0 && (
                        <ul className="list-disc list-inside text-xs text-amber-700">
                          {draft.reviewResult.issues.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      )}
                      {draft.reviewResult.suggestions.length > 0 && (
                        <ul className="list-disc list-inside text-xs text-amber-700 mt-1">
                          {draft.reviewResult.suggestions.map((s, i) => (
                            <li key={i}>💡 {s}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* Editable Students */}
                  {currentData.students.map((stu: any, si: number) => (
                    <div
                      key={si}
                      className="bg-white border border-gray-200 rounded-lg p-4 mb-3"
                    >
                      <h5 className="font-semibold text-gray-800 mb-3">
                        👤 {stu.name}
                      </h5>

                      {/* Editable Scores */}
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        {(["A", "B", "C"] as const).map((dim) => (
                          <div key={dim}>
                            <label className="text-xs text-gray-500 block mb-1">
                              {dimLabel[dim]}
                            </label>
                            <select
                              value={stu.scores[dim] ?? ""}
                              onChange={(e) =>
                                updateScore(
                                  draft.id,
                                  si,
                                  dim,
                                  e.target.value === ""
                                    ? null!
                                    : Number(e.target.value)
                                )
                              }
                              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                            >
                              <option value="">未提及</option>
                              {[0, 1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>
                                  {n} 分
                                </option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>

                      {/* Editable Events */}
                      <div>
                        <span className="text-xs text-gray-500">事件：</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {stu.events?.map((event: string, ei: number) => (
                            <span
                              key={ei}
                              className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded"
                            >
                              {event}
                              <button
                                onClick={() =>
                                  removeEvent(draft.id, si, ei)
                                }
                                className="hover:text-red-500"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Communication */}
                      {stu.communication && (
                        <div className="bg-purple-50 rounded p-2 mt-2">
                          <span className="text-xs font-medium text-purple-700">
                            📞 家校沟通
                          </span>
                          <p className="text-xs text-purple-600 mt-0.5">
                            {stu.communication.summary}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Alert */}
                  {currentData.alert_suggestion && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                      <span className="text-xs font-semibold text-red-700">
                        🚨 {currentData.alert_suggestion}
                      </span>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleAction(draft.id, "reject")}
                      disabled={isProcessing}
                      className="flex-1 py-2.5 border border-gray-300 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-100 disabled:opacity-50"
                    >
                      {isProcessing ? "处理中..." : "✕ 放弃"}
                    </button>
                    <button
                      onClick={() => handleAction(draft.id, "confirm")}
                      disabled={isProcessing}
                      className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
                    >
                      {isProcessing ? "处理中..." : "✓ 确认写入"}
                    </button>
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
