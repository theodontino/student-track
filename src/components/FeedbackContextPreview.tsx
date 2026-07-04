"use client";

import type { FeedbackContextStudent } from "@/components/wecom/types";

interface FeedbackContextPreviewProps {
  students: FeedbackContextStudent[];
  loading: boolean;
  error: string;
}

export default function FeedbackContextPreview({ students, loading, error }: FeedbackContextPreviewProps) {
  return (
    <section className="rounded-lg border border-blue-100 bg-blue-50/60 p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h4 className="text-sm font-semibold text-blue-900">生成前上下文预览</h4>
          <p className="text-xs text-blue-700 mt-1">这里展示本次反馈会参考的今日表现、近期趋势、家校沟通和标签。</p>
        </div>
        {loading && <span className="text-xs text-blue-600">读取中...</span>}
      </div>

      {error ? (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>
      ) : students.length === 0 ? (
        <div className="text-sm text-blue-700">{loading ? "正在整理上下文..." : "暂无可预览上下文"}</div>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {students.map((student) => (
            <div key={student.id} className="rounded-md border border-blue-100 bg-white p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="font-semibold text-gray-800">{student.name}</span>
                {student.preview.labels.length > 0 ? student.preview.labels.map((label) => (
                  <span key={label} className="rounded border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700">{label}</span>
                )) : <span className="text-xs text-gray-400">暂无标签</span>}
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <div>
                  <div className="text-xs font-medium text-gray-400 mb-1">今日表现</div>
                  <ul className="space-y-0.5 text-gray-700">
                    {student.preview.today.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                </div>
                <div>
                  <div className="text-xs font-medium text-gray-400 mb-1">近期趋势</div>
                  <p className="text-gray-700 leading-6">{student.preview.trend}</p>
                </div>
              </div>
              <div className="mt-2">
                <div className="text-xs font-medium text-gray-400 mb-1">家校沟通</div>
                {student.preview.communications.length > 0 ? (
                  <ul className="space-y-1 text-gray-700">
                    {student.preview.communications.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                ) : (
                  <p className="text-gray-400">暂无近期家校沟通</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
