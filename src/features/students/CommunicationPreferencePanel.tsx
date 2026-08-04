"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Section, Select, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";

type Value = string;
const fields = [
  ["length", "长度", ["unknown", "short", "standard", "detailed", "flexible"]],
  ["deliveryChannel", "反馈形式", ["unknown", "text", "voice", "either"]],
  ["phoneContact", "微信电话", ["unknown", "accepted", "not_accepted"]],
  ["evidence", "证据偏好", ["unknown", "teacher_conclusion", "classroom_example", "data_trend"]],
  ["terminology", "术语程度", ["unknown", "plain", "basic", "professional"]],
  ["familyParticipation", "家庭参与", ["unknown", "inform_only", "remind_confirm", "observe_report", "simple_check"]],
  ["frequency", "沟通频率", ["unknown", "every_session", "stage_only", "exception_only"]],
] as const;
const labels: Record<string, string> = { unknown: "未知", short: "简短", standard: "标准", detailed: "详细", flexible: "长短均可", text: "文字", voice: "语音", either: "文字或语音均可", accepted: "接受", not_accepted: "不接受", teacher_conclusion: "教师结论", classroom_example: "课堂例子", data_trend: "数据趋势", plain: "生活化", basic: "基础术语", professional: "专业细节", inform_only: "只知情", remind_confirm: "提醒/确认", observe_report: "观察/反馈", simple_check: "简单检查", every_session: "每次课", stage_only: "阶段性", exception_only: "异常时" };

export default function CommunicationPreferencePanel({ studentId }: { studentId: string }) {
  const [preference, setPreference] = useState<Record<string, Value> | null>(null);
  const [candidates, setCandidates] = useState<Array<{ id: string; status: string; preference: Record<string, Value> | null }>>([]);
  const [draft, setDraft] = useState<Record<string, Value>>({ length: "unknown", deliveryChannel: "unknown", phoneContact: "unknown", evidence: "unknown", terminology: "unknown", familyParticipation: "unknown", frequency: "unknown" });
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const data = await requestJson<{ preference?: { preference?: Record<string, Value> } | null; candidates: Array<{ id: string; status: string; preference: Record<string, Value> | null }> }>(`/api/students/${studentId}/communication-preference`);
    setPreference(data.preference?.preference ?? null); setCandidates(data.candidates);
  }, [studentId]);
  useEffect(() => { void load().catch((reason) => setMessage(reason instanceof Error ? reason.message : "读取沟通偏好失败")); }, [load]);
  async function saveManual() {
    try { await requestJson(`/api/students/${studentId}/communication-preference`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceType: "teacher", preference: { version: 1, ...draft }, evidence: { source: "teacher_manual" } }) }); setMessage("已生成待确认偏好候选；确认后才会影响反馈表达。"); await load(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : "保存沟通偏好失败"); }
  }
  async function decide(id: string, decision: "confirmed" | "rejected") {
    try { await requestJson(`/api/students/${studentId}/communication-preference/candidates/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }); await load(); }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : "更新偏好候选失败"); }
  }
  const summary = (value: Record<string, Value> | null) => value ? Object.entries(value).filter(([key]) => key !== "version").map(([key, item]) => `${key}=${labels[item] || item}`).join("；") : "未确认";
  return <Section title="家校沟通偏好" description="偏好只影响表达方式和候选排序，不改变事实、风险或家长动作边界.">{message && <StatusBanner tone="info">{message}</StatusBanner>}<p className="text-sm text-gray-600">当前：{summary(preference)}</p><div className="mt-3 grid gap-2 md:grid-cols-4">{fields.map(([key, label, options]) => <label key={key} className="text-xs font-semibold text-gray-600">{label}<Select className="mt-1" value={draft[key] || "unknown"} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}>{options.map((option) => <option key={option} value={option}>{labels[option] || option}</option>)}</Select></label>)}</div><Button uiSize="sm" className="mt-3" onClick={() => void saveManual()}>提交教师候选</Button>{candidates.filter((candidate) => candidate.status === "pending").map((candidate) => <div key={candidate.id} className="mt-3 flex items-center justify-between gap-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm"><span>待确认候选：{summary(candidate.preference)}</span><span className="flex gap-2"><Button uiSize="sm" onClick={() => void decide(candidate.id, "confirmed")}>确认</Button><Button uiSize="sm" variant="secondary" onClick={() => void decide(candidate.id, "rejected")}>拒绝</Button></span></div>)}</Section>;
}
