"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import SemesterPicker from "@/components/SemesterPicker";
import { DIM_LABEL } from "@/lib/constants";
import type { DraftParseResult } from "@/lib/types";

export default function InputPage() {
  const router = useRouter();
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DraftParseResult | null>(null);
  const [error, setError] = useState("");

  const [selectedSemesterId, setSelectedSemesterId] = useState("");
  const [selectedClass, setSelectedClass] = useState("");
  const [selectedSessionCode, setSelectedSessionCode] = useState("");

  async function handleSubmit() {
    if (!rawText.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const res = await fetch("/api/input/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText, sessionCode: selectedSessionCode || undefined }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "解析失败");

      setResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-2xl font-bold text-gray-800 mb-2">自然语言录入</h2>
      <p className="text-sm text-gray-500 mb-4">
        用自然语言描述学生表现，LLM 将自动解析并生成结构化草案。
      </p>

      {/* Semester/class/session picker */}
      <div className="mb-4">
        <SemesterPicker
          semesterId={selectedSemesterId}
          onSemesterChange={setSelectedSemesterId}
          className={selectedClass}
          onClassChange={setSelectedClass}
          sessionCode={selectedSessionCode}
          onSessionChange={setSelectedSessionCode}
        />
        {selectedSessionCode && (
          <span className="text-xs text-blue-600 font-medium">✓ 将关联到此课次</span>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder='例如：今天张三测验氧化还原全对，但上课走神。李四作业没交，情绪低落。给王五的妈妈打了电话讨论近况。'
          rows={5}
          className="w-full border border-gray-200 rounded-lg p-4 text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
        />
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-gray-400">{rawText.length} 字符</span>
          <button
            onClick={handleSubmit}
            disabled={loading || !rawText.trim()}
            className="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                LLM 分析中...
              </span>
            ) : (
              "提交分析"
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-red-700 text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
            ✅ 解析成功！草案已保存，请前往
            <button
              onClick={() => router.push("/review")}
              className="underline font-medium mx-1"
            >
              复核中心
            </button>
            确认后写入数据库。
          </div>

          {/* LLM Self-Review */}
          {result.reviewResult && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <h4 className="text-sm font-semibold text-amber-800 mb-2">
                🤖 LLM 自审意见
              </h4>
              {result.reviewResult.issues.length > 0 && (
                <div className="mb-2">
                  <span className="text-xs font-medium text-amber-700">
                    发现的问题：
                  </span>
                  <ul className="list-disc list-inside text-xs text-amber-700 mt-1">
                    {result.reviewResult.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.reviewResult.suggestions.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-amber-700">
                    建议：
                  </span>
                  <ul className="list-disc list-inside text-xs text-amber-700 mt-1">
                    {result.reviewResult.suggestions.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.reviewResult.issues.length === 0 &&
                result.reviewResult.suggestions.length === 0 && (
                  <p className="text-xs text-amber-700">未发现问题</p>
                )}
            </div>
          )}

          {/* Parsed Students */}
          {result.parsedResult.students.map((stu, idx) => (
            <div
              key={idx}
              className="bg-white border border-gray-200 rounded-lg p-5"
            >
              <h4 className="text-base font-semibold text-gray-800 mb-3">
                👤 {stu.name}
              </h4>

              {/* Scores */}
              <div className="grid grid-cols-3 gap-3 mb-3">
                {(["A", "B", "C"] as const).map((dim) => (
                  <div
                    key={dim}
                    className="bg-gray-50 rounded-lg p-3 text-center"
                  >
                    <div className="text-xs text-gray-500 mb-1">
                      {DIM_LABEL[dim]}
                    </div>
                    <div
                      className={`text-2xl font-bold ${
                        stu.scores[dim] !== null
                          ? stu.scores[dim]! >= 4
                            ? "text-green-600"
                            : stu.scores[dim]! >= 2
                            ? "text-yellow-600"
                            : "text-red-600"
                          : "text-gray-300"
                      }`}
                    >
                      {stu.scores[dim] !== null ? stu.scores[dim] : "—"}
                    </div>
                  </div>
                ))}
              </div>

              {/* Events */}
              {stu.events.length > 0 && (
                <div className="mb-2">
                  <span className="text-xs font-medium text-gray-500">
                    事件：
                  </span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {stu.events.map((event, i) => (
                      <span
                        key={i}
                        className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded"
                      >
                        {event}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Communication */}
              {stu.communication && (
                <div className="bg-purple-50 rounded p-2 mt-2">
                  <span className="text-xs font-medium text-purple-700">
                    📞 家校沟通 ({stu.communication.type})
                  </span>
                  <p className="text-xs text-purple-600 mt-0.5">
                    {stu.communication.summary}
                  </p>
                </div>
              )}
            </div>
          ))}

          {/* Alert */}
          {result.parsedResult.alert_suggestion && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <span className="text-sm font-semibold text-red-700">
                🚨 关注建议
              </span>
              <p className="text-sm text-red-600 mt-1">
                {result.parsedResult.alert_suggestion}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
