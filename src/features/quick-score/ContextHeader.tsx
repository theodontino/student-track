import type { ReactNode } from "react";

export default function ContextHeader({ semesterName, sessionCount, history, children }: { semesterName?: string; sessionCount?: number; history: ReactNode; children: ReactNode }) {
  return <><div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-bold text-gray-800">手动评分</h2><p className="mt-1 text-sm text-gray-500">录入三项评分与考勤，保存时只提交变动。{semesterName && <span className="ml-2 text-gray-400">| {semesterName} · 已上课 {sessionCount} 次</span>}</p></div>{history}</div><div className="mb-4">{children}</div></>;
}
