"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import SemesterPicker from "@/components/SemesterPicker";
import WorkHistoryButton from "@/components/WorkHistoryButton";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  MetricCard,
  PageHeader,
  Section,
  SegmentedControl,
  Select,
  StatusBanner,
} from "@/components/ui";
import type {
  ObservationStatus,
  TeachingEvidenceItem,
  TeachingSummaryBundle,
} from "@/lib/contracts/teaching-summary";
import { saveWorkHistory } from "@/lib/history";
import { requestJson } from "@/lib/api-client";
import {
  isDailyHistoryState,
  type DailyHistoryState,
  type TeachingSummaryHistoryState,
} from "./history-adapters";
import {
  type SemesterSummary,
  type TeachingContext,
} from "@/features/teaching-context/types";
import { isTeachingContext } from "@/features/teaching-context/url-context";
import { teachingContextWorkspaceKey } from "@/features/teaching-context/url-context";
import { useTeachingContext } from "@/features/teaching-context/use-teaching-context";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import TeacherObservationsPanel from "./TeacherObservationsPanel";

type SummaryView = "session" | "date";

interface TeachingSummarySessionState {
  context: TeachingContext;
  view: SummaryView;
  date: string;
  includeCommunications: boolean;
  bundle: TeachingSummaryBundle | null;
  legacyReport: string;
}

function isTeachingSummarySessionState(value: unknown): value is TeachingSummarySessionState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<TeachingSummarySessionState>;
  return isTeachingContext(state.context)
    && ["session", "date"].includes(String(state.view))
    && typeof state.date === "string"
    && typeof state.includeCommunications === "boolean"
    && typeof state.legacyReport === "string";
}

function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function EvidenceSection({ title, items }: { title: string; items: TeachingEvidenceItem[] }) {
  return <section className="space-y-3">
    <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
    {items.length === 0 ? <p className="text-sm text-gray-500">没有足够证据形成此类结论。</p> : items.map((item, index) => <article key={`${item.title}-${index}`} className="rounded-xl border border-gray-200 bg-white/70 p-4">
      <strong className="text-sm">{item.title}</strong>
      <p className="mt-1 text-sm leading-6 text-gray-700">{item.detail}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {item.sources.students.map((student) => <a className="text-blue-700 hover:underline" href={student.href} key={student.id}>{student.name}</a>)}
        {item.sources.sessions.map((session) => <a className="text-blue-700 hover:underline" href={session.href} key={session.id}>{session.date} · {session.code}</a>)}
        {item.sources.communications.map((communication) => <a className="text-amber-800 hover:underline" href={communication.href} key={communication.id}>{communication.occurredAt.slice(0, 10)} 沟通</a>)}
      </div>
    </article>)}
  </section>;
}

function FactsView({ bundle }: { bundle: TeachingSummaryBundle }) {
  const { facts } = bundle;
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="课次" value={facts.totals.sessionCount} detail={`${facts.totals.classCount} 个班级`} tone="brand" />
      <MetricCard label="覆盖学生" value={facts.totals.coveredStudentCount} detail={`${facts.totals.metricRecordedCount} 条评分`} />
      <MetricCard label="出勤记录" value={facts.totals.attendanceRecordedCount} detail={`${facts.totals.presentCount} 出勤 · ${facts.totals.absentCount} 缺勤`} />
      <MetricCard label="待处理" value={facts.pendingItems.reduce((sum, item) => sum + item.count, 0)} detail={`${facts.totals.pendingDraftCount} 条待复核草案`} tone={facts.pendingItems.length ? "warning" : "neutral"} />
    </div>
    <div className="grid gap-3 lg:grid-cols-2">
      {facts.sessions.map((session) => <article key={session.id} className="rounded-2xl border border-gray-200 bg-white/70 p-5">
        <header className="flex items-start justify-between gap-3"><div><strong>{session.className}</strong><p className="mt-1 text-xs text-gray-500">{session.date} · 第 {session.semesterNumber} 次 · {session.code}</p></div><a className="text-xs font-semibold text-blue-700 hover:underline" href={session.href}>打开课次 →</a></header>
        <div className="mt-4 grid grid-cols-4 gap-2 text-center text-xs">{(["A", "B", "C", "D"] as const).map((dimension) => <div key={dimension} className="rounded-xl bg-gray-50 p-3"><span className="text-gray-500">{dimension}</span><strong className="mt-1 block text-base">{session.averages[dimension] ?? "—"}</strong></div>)}</div>
        <p className="mt-3 text-xs leading-5 text-gray-600">评分 {session.metricRecordedCount}/{session.studentCount} · 考勤 {session.attendanceRecordedCount}/{session.studentCount} · 事件 {session.eventCount} · 已确认沟通 {session.communicationCount}</p>
      </article>)}
    </div>
    <Section title="确定性待办" description="这里只陈述数据库中可以直接证明的缺漏，不由 AI 推断">
      {facts.pendingItems.length === 0 ? <StatusBanner tone="success">本范围没有发现确定性待办。</StatusBanner> : <div className="grid gap-2">{facts.pendingItems.map((item, index) => <a href={item.href} key={`${item.sessionCode}-${item.type}-${index}`} className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><span>{item.sessionCode} · {item.label}</span><Badge tone="warning">{item.count}</Badge></a>)}</div>}
    </Section>
  </div>;
}

export default function DailyReportWorkspace() {
  const { context, hydrated: contextHydrated, setContext, setSemesterId, setClassName, setSessionCode } = useTeachingContext();
  const { semesterId, className, sessionCode } = context;
  const [semesters, setSemesters] = useState<SemesterSummary[]>([]);
  const [view, setView] = useState<SummaryView>("session");
  const [date, setDate] = useState(shanghaiToday);
  const [includeCommunications, setIncludeCommunications] = useState(true);
  const [bundle, setBundle] = useState<TeachingSummaryBundle | null>(null);
  const [legacyReport, setLegacyReport] = useState("");
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const workspaceValue = useMemo<TeachingSummarySessionState>(() => ({
    context, view, date, includeCommunications, bundle, legacyReport,
  }), [bundle, context, date, includeCommunications, legacyReport, view]);

  useSessionWorkspace({
    key: teachingContextWorkspaceKey("daily-report", context),
    value: workspaceValue,
    validate: isTeachingSummarySessionState,
    enabled: contextHydrated,
    restore: (saved) => {
      setView(saved?.view ?? "session");
      setDate(saved?.date ?? shanghaiToday());
      setIncludeCommunications(saved?.includeCommunications ?? true);
      setBundle(saved?.bundle ?? null);
      setLegacyReport(saved?.legacyReport ?? "");
      setError("");
    },
  });

  useEffect(() => {
    requestJson<SemesterSummary[]>("/api/semesters").then(setSemesters).catch(() => setSemesters([]));
  }, []);

  useEffect(() => {
    if (view !== "date" || !semesterId) return;
    const semester = semesters.find((item) => item.id === semesterId);
    if (!semester?.startDate || !semester.endDate || date >= semester.startDate && date <= semester.endDate) return;
    const today = shanghaiToday();
    setDate(today < semester.startDate ? semester.startDate : today > semester.endDate ? semester.endDate : today);
  }, [date, semesterId, semesters, view]);

  const ready = view === "session" ? Boolean(sessionCode) : Boolean(semesterId && date);
  const query = useCallback(() => {
    const params = new URLSearchParams({
      scope: view,
      includeCommunications: includeCommunications ? "1" : "0",
    });
    if (view === "session") params.set("sessionCode", sessionCode);
    else {
      params.set("semesterId", semesterId);
      params.set("date", date);
    }
    return params;
  }, [date, includeCommunications, semesterId, sessionCode, view]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!ready) {
      setBundle(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await requestJson<TeachingSummaryBundle>(`/api/report/teaching-summary?${query()}`, { signal });
      setBundle(result);
      setLegacyReport("");
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      setError(reason instanceof Error ? reason.message : "读取教学总结失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [query, ready]);

  useEffect(() => {
    if (!contextHydrated) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [contextHydrated, load]);

  async function generate(forceRefresh = false) {
    if (!ready) return;
    setGenerating(true);
    setError("");
    try {
      const result = await requestJson<TeachingSummaryBundle>("/api/report/teaching-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: view === "session"
            ? { type: "session", sessionCode }
            : { type: "date", semesterId, date },
          includeCommunications,
          forceRefresh,
        }),
      });
      setBundle(result);
      setLegacyReport("");
      const history: TeachingSummaryHistoryState = {
        kind: "teaching-summary",
        view,
        semesterId,
        className,
        sessionCode,
        date,
        includeCommunications,
        bundle: result,
      };
      await saveWorkHistory(
        "report",
        view === "session" ? `${className} ${sessionCode} 教学总结` : `${date} 教学总结`,
        history,
        view === "session" ? sessionCode : `${semesterId}:${date}`,
      ).catch((historyError) => console.error("save teaching summary history failed:", historyError));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成教学总结失败");
    } finally {
      setGenerating(false);
    }
  }

  async function updateObservation(id: string, status: ObservationStatus) {
    const updated = await requestJson<TeachingSummaryBundle["observations"][number]>(`/api/teacher-observations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBundle((current) => current ? {
      ...current,
      observations: current.observations.map((item) => item.id === id ? updated : item),
    } : current);
  }

  function restore(state: DailyHistoryState) {
    if (state.kind === "daily") {
      setContext({ semesterId: state.semesterId, className: state.className, sessionCode: state.sessionCode });
      setView("session");
      setLegacyReport(state.report);
      setBundle(null);
    } else {
      setContext({
        semesterId: state.semesterId,
        className: state.className,
        sessionCode: state.sessionCode,
      });
      setView(state.view);
      setDate(state.date);
      setIncludeCommunications(state.includeCommunications);
      setBundle(state.bundle);
      setLegacyReport("");
    }
    setError("");
  }

  return <div className="mx-auto max-w-6xl space-y-5">
    <PageHeader
      title="教学总结"
      description="先查看可验证的课堂事实，再按需生成教师内部 AI 解读与家校沟通观察。"
      actions={<WorkHistoryButton<DailyHistoryState> module="report" accept={isDailyHistoryState} onRestore={restore} />}
    />
    <Card className="space-y-5 p-6">
      <SegmentedControl label="教学总结范围" items={[{ value: "session", label: "按课次" }, { value: "date", label: "按日期" }]} value={view} onChange={(value) => setView(value as SummaryView)} />
      {view === "session" ? <SemesterPicker semesterId={semesterId} onSemesterChange={setSemesterId} className={className} onClassChange={setClassName} sessionCode={sessionCode} onSessionChange={setSessionCode} /> : <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-semibold text-gray-500">学期
          <Select value={semesterId} onChange={(event) => setSemesterId(event.target.value)}>
            <option value="">请选择学期</option>
            {semesters.map((semester) => <option key={semester.id} value={semester.id}>{semester.name}</option>)}
          </Select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-gray-500">日期
          <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
      </div>}
      <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <input className="mt-1" type="checkbox" checked={includeCommunications} onChange={(event) => setIncludeCommunications(event.target.checked)} />
        <span><strong>纳入已确认家校沟通</strong><small className="mt-1 block text-amber-800">只使用 Student Track 已确认摘要；关闭后沟通内容不会进入本次模型请求。</small></span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={!ready || generating} onClick={() => void generate(false)}>{generating ? "生成中…" : bundle?.analysis ? "使用当前缓存" : "生成 AI 教师解读"}</Button>
        {bundle?.analysis && <Button variant="ghost" disabled={generating} onClick={() => void generate(true)}>重新生成</Button>}
        {bundle && <span className="text-xs text-gray-500">已确认沟通输入 {bundle.facts.totals.communicationCount} 条{bundle.facts.totals.communicationInputTruncated ? "（部分历史已截断）" : ""}</span>}
      </div>
      {bundle?.cache.status === "stale" && <StatusBanner tone="warning">课堂数据或模型配置已经变化，旧 AI 解读未与新事实混合显示。请按需重新生成。</StatusBanner>}
      {error && <StatusBanner tone="danger">{error}；确定性事实如已载入将继续保留。</StatusBanner>}
    </Card>

    {loading ? <div className="py-10 text-center text-sm text-gray-500">正在计算确定性教学事实…</div> : bundle ? <>
      <FactsView bundle={bundle} />
      <Section title="AI 教师解读" description="只解释上方事实；不修改评分、考勤、标签或家长反馈">
        {bundle.analysis ? <div className="space-y-6">
          {bundle.analysis.overview && <div className="rounded-2xl border border-blue-200 bg-blue-50/80 p-5 text-sm leading-7 text-gray-800">{bundle.analysis.overview}</div>}
          <EvidenceSection title="班级差异" items={bundle.analysis.classComparisons} />
          <EvidenceSection title="值得留意的变化" items={bundle.analysis.noteworthyChanges} />
          <EvidenceSection title="建议后续动作" items={bundle.analysis.suggestedActions} />
        </div> : <EmptyState title="尚未生成 AI 教师解读" description="确定性事实已经可用；只有点击生成时才会调用当前模型。" />}
      </Section>
      <Section title="家校沟通观察" description="教师内部待办；与现有警告、持续关注和考勤提醒完全隔离">
        <TeacherObservationsPanel items={bundle.observations} onStatusChange={updateObservation} />
      </Section>
    </> : legacyReport ? <Section title="旧版班级日报" description="这是 v0.21.0 之前保存的兼容历史记录"><div className="whitespace-pre-wrap rounded-xl border border-blue-100 bg-blue-50 p-5 text-sm leading-7 text-gray-700">{legacyReport}</div></Section> : error ? <ErrorState message={error} action={<Button onClick={() => void load()}>重试</Button>} /> : <EmptyState title="请选择总结范围" description="选择课次，或切换到按日期查看当天全部班级。" />}
  </div>;
}
