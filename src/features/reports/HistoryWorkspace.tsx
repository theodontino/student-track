"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, EmptyState, Input, LoadingState, PageHeader, Select, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { useClasses, useSemesters, useSessions } from "@/features/teaching-context/use-options";

interface FeedbackPlanSummary {
  id: string;
  type: string;
  status: string;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  outputRequirement: string;
  session?: { id: string; code: string; date: string; semesterNumber: number } | null;
  rangeEndSession?: { id: string; code: string; date: string; semesterNumber: number } | null;
  class?: { id: string; code: string; name?: string | null } | null;
  semester?: { id: string; name: string } | null;
  studentSummaries: Array<{ id: string; name: string; studentId: string }>;
  itemStatusCounts: { total: number; queued: number; running: number; completed: number; failed: number; stale: number };
}

interface HistoryStudentOption {
  id: string;
  name: string;
  studentId: string;
  classId: string;
  rosterStatus: "ACTIVE" | "INACTIVE";
}

const typeLabels: Record<string, string> = {
  class_update: "班级公共反馈",
  event_micro: "事件型微反馈",
  stage_trend: "阶段趋势反馈",
  course_end: "结课教学总结",
};

const statusLabels: Record<string, string> = {
  draft: "草稿",
  evidence_ready: "证据就绪",
  queued: "排队中",
  generating: "生成中",
  pause_requested: "暂停中",
  paused: "已暂停",
  generation_failed: "有失败",
  in_review: "待复核",
  approved: "已批准",
  partially_approved: "部分批准",
  exported: "已导出",
  partially_exported: "部分导出",
  stale: "证据已变化",
};

function restoreHref(plan: FeedbackPlanSummary) {
  const running = ["queued", "generating", "pause_requested", "paused"].includes(plan.status);
  const step = running ? "generate" : ["draft", "evidence_ready", "needs_review", "stale", "generation_failed"].includes(plan.status) ? "review" : "export";
  const sessionCode = (plan.type === "stage_trend" || plan.type === "course_end" ? plan.rangeEndSession : plan.session)?.code ?? "";
  const params = new URLSearchParams({ step, planId: plan.id });
  if (plan.semester?.id) params.set("semesterId", plan.semester.id);
  if (plan.class?.id) params.set("classId", plan.class.id);
  if (plan.class?.name || plan.class?.code) params.set("class", plan.class.name ?? plan.class.code);
  if (sessionCode) params.set("sessionCode", sessionCode);
  return `/feedback?${params.toString()}`;
}

export default function HistoryWorkspace() {
  const router = useRouter();
  const [semesterId, setSemesterId] = useState("");
  const [classId, setClassId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [date, setDate] = useState("");
  const [status, setStatus] = useState("");
  const [archived, setArchived] = useState("false");
  const [plans, setPlans] = useState<FeedbackPlanSummary[]>([]);
  const [studentOptions, setStudentOptions] = useState<HistoryStudentOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const semesters = useSemesters();
  const classes = useClasses(semesterId);
  const selectedClass = classes.find((entry) => entry.id === classId);
  const sessions = useSessions(semesterId, classId, selectedClass?.name ?? selectedClass?.code ?? "");
  const visibleStudents = classId ? studentOptions.filter((student) => student.classId === classId) : studentOptions;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSemesterId(params.get("semesterId") ?? "");
    setClassId(params.get("classId") ?? "");
    setSessionId(params.get("sessionId") ?? "");
    setStudentId(params.get("studentId") ?? "");
    setDate(params.get("date") ?? "");
    setStatus(params.get("status") ?? "");
    if (params.get("archived") === "true") setArchived("true");
  }, []);

  useEffect(() => {
    if (!semesterId) { setStudentOptions([]); return; }
    requestJson<HistoryStudentOption[]>(`/api/students?${new URLSearchParams({ semesterId, scope: "all" })}`)
      .then(setStudentOptions)
      .catch(() => setStudentOptions([]));
  }, [semesterId]);
  const query = useMemo(() => {
    const params = new URLSearchParams({ archived });
    for (const [key, value] of Object.entries({ semesterId, classId, sessionId, studentId, date, status })) if (value) params.set(key, value);
    return params.toString();
  }, [archived, classId, date, semesterId, sessionId, status, studentId]);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const payload = await requestJson<{ plans: FeedbackPlanSummary[] }>(`/api/report/feedback-plans?${query}`);
      setPlans(payload.plans);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "加载反馈历史失败"); }
    finally { setLoading(false); }
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  async function setArchive(plan: FeedbackPlanSummary, nextArchived: boolean) {
    try {
      await requestJson(`/api/report/feedback-plans/${encodeURIComponent(plan.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: nextArchived ? "archive" : "unarchive" }) });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "更新归档状态失败"); }
  }

  return <main className="history-workspace">
    <PageHeader title="反馈历史" description="FeedbackPlan 是反馈流程和恢复历史的唯一权威来源。按教学上下文查找并继续处理。" />
    <section className="grid gap-3 rounded-2xl border border-gray-200 bg-white p-4 md:grid-cols-3">
      <Select aria-label="学期" value={semesterId} onChange={(event) => { setSemesterId(event.target.value); setClassId(""); setSessionId(""); setStudentId(""); }}>
        <option value="">全部学期</option>
        {semesters.map((semester) => <option value={semester.id} key={semester.id}>{semester.name}</option>)}
      </Select>
      <Select aria-label="班级" value={classId} disabled={!semesterId} onChange={(event) => { setClassId(event.target.value); setSessionId(""); setStudentId(""); }}>
        <option value="">{semesterId ? "全部班级" : "请先选择学期"}</option>
        {classes.map((entry) => <option value={entry.id} key={entry.id}>{entry.name ?? entry.code}</option>)}
      </Select>
      <Select aria-label="课次" value={sessionId} disabled={!classId} onChange={(event) => setSessionId(event.target.value)}>
        <option value="">{classId ? "全部课次" : "请先选择班级"}</option>
        {sessions.flatMap((session) => session.id ? [<option value={session.id} key={session.id}>{session.date} · {session.code} · 第{session.semesterNumber}次</option>] : [])}
      </Select>
      <Select aria-label="学生" value={studentId} disabled={!semesterId} onChange={(event) => setStudentId(event.target.value)}>
        <option value="">{semesterId ? "全部学生" : "请先选择学期"}</option>
        {visibleStudents.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.studentId}{student.rosterStatus === "INACTIVE" ? " · 停读" : ""}</option>)}
      </Select>
      <Input aria-label="课程日期" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      <Select aria-label="状态" value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">全部状态</option>
        {Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </Select>
      <Select aria-label="归档" value={archived} onChange={(event) => setArchived(event.target.value)}>
        <option value="false">当前计划</option>
        <option value="true">已归档计划</option>
      </Select>
      <Button variant="secondary" onClick={() => void load()}>刷新</Button>
    </section>
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {loading ? <LoadingState label="加载反馈历史中…" /> : plans.length === 0 ? <EmptyState title="暂无反馈计划" description="调整筛选条件，或从课后工作台创建新的反馈计划。" /> : <section className="mt-4 grid gap-3">
      {plans.map((plan) => {
        const session = (plan.type === "stage_trend" || plan.type === "course_end" ? plan.rangeEndSession : plan.session) ?? undefined;
        return <article key={plan.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="font-semibold text-gray-900">{typeLabels[plan.type] ?? plan.type}</h2><p className="text-sm text-gray-500">{plan.semester?.name ?? plan.semester?.id} · {plan.class?.name ?? plan.class?.code ?? plan.class?.id} · {session?.code ?? "阶段计划"}</p></div>
            <span className="rounded-full bg-gray-100 px-2 py-1 text-xs">{statusLabels[plan.status] ?? plan.status}</span>
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-gray-700">{plan.outputRequirement}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-500"><span>课程日期：{session?.date ?? "—"}</span><span>学生：{plan.studentSummaries.length ? plan.studentSummaries.map((student) => student.name).join("、") : "班级公共"}</span><span>条目 {plan.itemStatusCounts.completed}/{plan.itemStatusCounts.total} 完成</span><span>更新：{new Date(plan.updatedAt).toLocaleString("zh-CN")}</span></div>
          <div className="mt-3 flex flex-wrap gap-2"><Button uiSize="sm" onClick={() => router.push(restoreHref(plan))}>恢复</Button><Button uiSize="sm" variant="secondary" onClick={() => void setArchive(plan, !Boolean(plan.archivedAt))}>{plan.archivedAt ? "取消归档" : "归档"}</Button></div>
        </article>;
      })}
    </section>}
  </main>;
}
