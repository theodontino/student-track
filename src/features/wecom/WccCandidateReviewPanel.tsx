"use client";

import { useEffect, useState } from "react";

type Candidate = {
  id: string;
  sessionCode: string | null;
  student: { id: string; name: string; studentId: string } | null;
  parsedResult: {
    students?: Array<{ communication?: { type: string; summary: string } }>;
  };
  source: {
    conversation?: { title?: string };
    messageIds?: string[];
    evidence?: Array<{ messageId: string; quote: string }>;
  };
  sessions: Array<{ code: string; date: string; semesterNumber: number }>;
};

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

export default function WccCandidateReviewPanel() {
  const [items, setItems] = useState<Candidate[]>([]);
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const refresh = () => request("/api/wecom/review-drafts").then(setItems).catch((error) => setMessage(error.message));
  useEffect(() => { refresh(); }, []);

  async function decide(item: Candidate, action: "confirm" | "reject") {
    try {
      const sessionCode = sessions[item.id] || item.sessionCode || "";
      if (action === "confirm" && !sessionCode) throw new Error("请先选择实际课次");
      if (action === "confirm" && sessionCode !== item.sessionCode) {
        await request("/api/wecom/review-drafts", {
          method: "PATCH",
          body: JSON.stringify({ draftId: item.id, sessionCode }),
        });
      }
      await request("/api/wecom/review-drafts", {
        method: "POST",
        body: JSON.stringify({ draftId: item.id, action }),
      });
      setMessage(action === "confirm" ? "已确认并写入学生档案" : "已忽略候选");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "处理失败");
    }
  }

  return <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
    <div className="flex items-start justify-between gap-4">
      <div><h3 className="font-semibold text-gray-800">WCC 已对齐候选</h3><p className="mt-1 text-sm text-gray-500">Student Track 已完成业务提取；核对证据并选择实际课次后才正式入库。</p></div>
      <span className="rounded-full bg-blue-50 px-3 py-1 text-sm text-blue-700">{items.length} 项待复核</span>
    </div>
    {message && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{message}</p>}
    {items.length === 0 ? <p className="py-8 text-center text-sm text-gray-500">暂时没有 WCC 待复核候选。</p> : items.map((item) => {
      const communication = item.parsedResult.students?.[0]?.communication;
      return <article className="rounded-lg border border-slate-200 p-4 space-y-3" key={item.id}>
        <div className="flex flex-wrap items-center gap-2 text-sm"><strong>{item.student?.name || "学生已失效"}</strong><span className="text-gray-500">{item.student?.studentId}</span><span className="text-gray-400">·</span><span>{item.source.conversation?.title || "未命名会话"}</span></div>
        <p className="text-sm leading-6 text-gray-800">{communication?.summary || "没有可显示的沟通摘要"}</p>
        {!!item.source.evidence?.length && <details className="text-sm"><summary className="cursor-pointer text-blue-700">查看 {item.source.evidence.length} 条原文证据</summary><div className="mt-2 space-y-2">{item.source.evidence.map((evidence) => <blockquote className="border-l-2 border-amber-300 pl-3 text-gray-600" key={`${evidence.messageId}-${evidence.quote}`}>{evidence.quote}<code className="ml-2 text-xs">{evidence.messageId}</code></blockquote>)}</div></details>}
        <div className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-sm"><span>实际课次</span><select className="rounded-md border border-slate-300 px-3 py-2" value={sessions[item.id] || item.sessionCode || ""} onChange={(event) => setSessions({ ...sessions, [item.id]: event.target.value })}><option value="">请选择课次…</option>{item.sessions.map((session) => <option value={session.code} key={session.code}>{session.date} · 第 {session.semesterNumber} 次 · {session.code}</option>)}</select></label><button className="rounded-md border border-amber-300 px-4 py-2 text-sm text-amber-800" onClick={() => decide(item, "reject")}>忽略</button><button className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white" onClick={() => decide(item, "confirm")}>确认入库</button></div>
      </article>;
    })}
  </section>;
}
