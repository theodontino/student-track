"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, Dialog, EmptyState, ErrorState, Input, LoadingState, MetricCard, PageHeader, Section, StatusBanner } from "@/components/ui";
import { ClassGroupPanel } from "@/features/courses/ClassGroupPanel";
import { downloadFile, requestJson } from "@/lib/api-client";

interface Session {
  id: string;
  code: string;
  date: string;
  semesterNumber: number;
  class: { id?: string; code: string; name: string | null } | null;
  groupLessonSession?: { groupLesson: { id: string; sequence: number; title: string } } | null;
  _count: { attendances: number };
}
interface SemesterClass { id: string; code: string; name: string | null; activeStudentCount: number; inactiveStudentCount: number; sessionCount: number; }
interface SemesterDetail { id: string; name: string; startDate: string; endDate: string; sessions: Session[]; classes: SemesterClass[]; sessionCount: number; totalStudents: number; attendances: number; }
interface ProgressChoice { group: { id: string; name: string }; lesson: { id: string; sequence: number; title: string } | null; status: string; }

export default function SemesterDetailWorkspace() {
  const params = useParams();
  const router = useRouter();
  const [semester, setSemester] = useState<SemesterDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [classDialogOpen, setClassDialogOpen] = useState(false);
  const [editingClass, setEditingClass] = useState<SemesterClass | null>(null);
  const [classCode, setClassCode] = useState("");
  const [className, setClassName] = useState("");
  const [classError, setClassError] = useState("");
  const [savingClass, setSavingClass] = useState(false);
  const [exportingClassId, setExportingClassId] = useState<string | null>(null);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [sessionClassId, setSessionClassId] = useState("");
  const [sessionDate, setSessionDate] = useState(new Date().toISOString().slice(0, 10));
  const [savingSession, setSavingSession] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [progressSession, setProgressSession] = useState<Session | null>(null);
  const [progressChoice, setProgressChoice] = useState("");
  const [progressLessons, setProgressLessons] = useState<Array<{ id: string; sequence: number; title: string }>>([]);
  const [progressGroupName, setProgressGroupName] = useState("");
  const [savingProgress, setSavingProgress] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setSemester(await requestJson<SemesterDetail>(`/api/semesters/${params.id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "加载学期详情失败"); }
    finally { setLoading(false); }
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);

  function openClassDialog(klass?: SemesterClass) {
    setEditingClass(klass ?? null);
    setClassCode(klass?.code ?? "");
    setClassName(klass?.name ?? "");
    setClassError("");
    setClassDialogOpen(true);
  }

  async function saveClass(event: React.FormEvent) {
    event.preventDefault();
    setSavingClass(true);
    setClassError("");
    try {
      await requestJson<SemesterClass>(editingClass ? `/api/classes/${editingClass.id}` : `/api/semesters/${semester?.id ?? params.id}/classes`, {
        method: editingClass ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: classCode, name: className || null }),
      });
      setClassDialogOpen(false);
      await load();
    } catch (reason) {
      setClassError(reason instanceof Error ? reason.message : "保存班级失败");
    } finally {
      setSavingClass(false);
    }
  }

  async function exportStepRoster(klass: SemesterClass) {
    setExportingClassId(klass.id);
    setError("");
    try { await downloadFile(`/api/classes/${encodeURIComponent(klass.id)}/step-roster`, `${klass.code}.step-roster.json`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "导出 STEP 花名册失败"); }
    finally { setExportingClassId(null); }
  }

  async function createSession(event: React.FormEvent) {
    event.preventDefault();
    if (!semester || !sessionClassId) return;
    setSavingSession(true); setSessionError("");
    try {
      await requestJson(`/api/semesters/${encodeURIComponent(semester.id)}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classId: sessionClassId, date: sessionDate }) });
      setSessionDialogOpen(false); await load();
    } catch (reason) { setSessionError(reason instanceof Error ? reason.message : "创建课次失败"); }
    finally { setSavingSession(false); }
  }

  async function openProgress(session: Session) {
    setSessionError("");
    try {
      const [{ progress }, { groups }] = await Promise.all([
        requestJson<{ progress: ProgressChoice | null }>(`/api/sessions/${encodeURIComponent(session.id)}/group-progress`),
        requestJson<{ groups: Array<{ id: string; lessons: Array<{ id: string; sequence: number; title: string }> }> }>(`/api/semesters/${encodeURIComponent(semester?.id ?? "")}/class-groups`),
      ]);
      if (!progress) { setSessionError("该班级不属于班级组，无需调整共同进度。"); return; }
      setProgressSession(session); setProgressGroupName(progress.group.name); setProgressLessons(groups.find((group) => group.id === progress.group.id)?.lessons ?? []); setProgressChoice(progress.lesson?.id ?? "");
    } catch (reason) { setSessionError(reason instanceof Error ? reason.message : "读取共同进度失败"); }
  }

  async function saveProgress(event: React.FormEvent) {
    event.preventDefault();
    if (!progressSession) return;
    setSavingProgress(true); setSessionError("");
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(progressSession.id)}/group-progress`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groupLessonId: progressChoice || null }) });
      setProgressSession(null); await load();
    } catch (reason) { setSessionError(reason instanceof Error ? reason.message : "调整共同进度失败"); }
    finally { setSavingProgress(false); }
  }

  if (loading) return <LoadingState label="正在加载学期详情…" />;
  if (error) return <ErrorState message={error} action={<Button onClick={() => void load()}>重试</Button>} />;
  if (!semester) return <EmptyState title="学期不存在" />;

  return <main className="semester-detail-workspace">
    <PageHeader
      title={semester.name}
      description={`${semester.startDate} → ${semester.endDate}`}
      actions={<div className="semester-detail-actions"><Button variant="secondary" onClick={() => router.push(`/students?semesterId=${encodeURIComponent(semester.id)}`)}>导入花名册</Button><Button onClick={() => openClassDialog()}>新建班级</Button></div>}
    />
    <div className="semester-metrics"><MetricCard label="课次总数" value={semester.sessionCount} tone="brand" /><MetricCard label="学生总数" value={semester.totalStudents} tone="success" /><MetricCard label="考勤记录总数" value={semester.attendances} tone="warning" /></div>
    <Section title="班级列表" description="班级编号只在本学期内唯一；不同学期可以复用同一编号。">
      {semester.classes.length === 0 ? <EmptyState title="暂无班级" description="先创建班级或从学生页导入本学期花名册。" action={<Button onClick={() => openClassDialog()}>新建班级</Button>} /> : <div className="semester-session-table-wrap"><table className="semester-session-table"><thead><tr><th>班级编号</th><th>班级名称</th><th>在读人数</th><th>非活跃人数</th><th>课次数</th><th>操作</th></tr></thead><tbody>{semester.classes.map((klass) => <tr key={klass.id}><td>{klass.code}</td><td>{klass.name ?? "—"}</td><td>{klass.activeStudentCount}</td><td>{klass.inactiveStudentCount}</td><td>{klass.sessionCount}</td><td><Button variant="ghost" uiSize="sm" onClick={() => openClassDialog(klass)}>编辑</Button>{" "}<Button variant="ghost" uiSize="sm" onClick={() => void exportStepRoster(klass)} disabled={exportingClassId !== null}>{exportingClassId === klass.id ? "导出中…" : "导出到 STEP"}</Button></td></tr>)}</tbody></table></div>}
    </Section>
    <ClassGroupPanel semesterId={semester.id} classes={semester.classes} sessions={semester.sessions} />
    <Section title="课次列表" description="真实课次属于具体班级；班级组共同进度只说明本班正在完成第几讲。" actions={<Button onClick={() => { setSessionClassId(semester.classes[0]?.id ?? ""); setSessionError(""); setSessionDialogOpen(true); }} disabled={semester.classes.length === 0}>新建课次</Button>}>
      {sessionError && !sessionDialogOpen && !progressSession && <StatusBanner tone="danger">{sessionError}</StatusBanner>}
      {semester.sessions.length === 0 ? <EmptyState title="暂无课次记录" /> : <div className="semester-session-table-wrap"><table className="semester-session-table"><thead><tr><th>课次编码</th><th>日期</th><th>学期序号</th><th>班级</th><th>班级组进度</th><th>考勤人数</th><th>操作</th></tr></thead><tbody>{semester.sessions.map((session) => <tr key={session.id}><td>{session.code}</td><td>{session.date}</td><td>第 {session.semesterNumber} 次</td><td>{session.class ? (session.class.name ?? session.class.code) : "全校"}</td><td>{session.groupLessonSession?.groupLesson ? `第 ${session.groupLessonSession.groupLesson.sequence} 讲 · ${session.groupLessonSession.groupLesson.title}` : "独立课次"}</td><td>{session._count.attendances}</td><td><Button variant="ghost" uiSize="sm" onClick={() => void openProgress(session)} disabled={!session.class}>调整共同进度</Button></td></tr>)}</tbody></table></div>}
    </Section>
    <Dialog open={classDialogOpen} title={editingClass ? "编辑班级" : "新建班级"} onClose={() => { if (!savingClass) setClassDialogOpen(false); }}>
      <form onSubmit={saveClass} className="dialog-form">{classError && <StatusBanner tone="danger">{classError}</StatusBanner>}<label>班级编号<Input required value={classCode} onChange={(event) => setClassCode(event.target.value)} /></label><label>班级名称<Input value={className} onChange={(event) => setClassName(event.target.value)} /></label><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setClassDialogOpen(false)} disabled={savingClass}>取消</Button><Button type="submit" disabled={savingClass}>{savingClass ? "保存中…" : "保存班级"}</Button></div></form>
    </Dialog>
    <Dialog open={sessionDialogOpen} title="新建真实课次" onClose={() => { if (!savingSession) setSessionDialogOpen(false); }}><form className="dialog-form" onSubmit={createSession}>{sessionError && <StatusBanner tone="danger">{sessionError}</StatusBanner>}<label>班级<select required value={sessionClassId} onChange={(event) => setSessionClassId(event.target.value)}>{semester.classes.map((klass) => <option key={klass.id} value={klass.id}>{klass.name ?? klass.code}</option>)}</select></label><label>上课日期<Input required type="date" value={sessionDate} onChange={(event) => setSessionDate(event.target.value)} /></label><p className="dialog-form__hint">如果班级属于班级组，系统会按主班规则自动进入共同进度；评分、考勤和事件仍只属于本班课次。</p><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setSessionDialogOpen(false)}>取消</Button><Button type="submit" disabled={savingSession || !sessionClassId}>{savingSession ? "创建中…" : "创建课次"}</Button></div></form></Dialog>
    <Dialog open={Boolean(progressSession)} title="调整班级组共同进度" onClose={() => { if (!savingProgress) setProgressSession(null); }}><form className="dialog-form" onSubmit={saveProgress}>{sessionError && <StatusBanner tone="danger">{sessionError}</StatusBanner>}<p className="dialog-form__hint">{progressGroupName} · {progressSession?.class?.name ?? progressSession?.class?.code} · {progressSession?.code}</p><label>对应共同课<select value={progressChoice} onChange={(event) => setProgressChoice(event.target.value)}><option value="">设为独立课次</option>{progressLessons.map((lesson) => <option key={lesson.id} value={lesson.id}>第 {lesson.sequence} 讲 · {lesson.title}</option>)}</select></label><p className="dialog-form__hint">调整只改变共同进度关系，不移动或合并本课的评分、考勤和事件。</p><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setProgressSession(null)}>取消</Button><Button type="submit" disabled={savingProgress}>{savingProgress ? "保存中…" : "保存调整"}</Button></div></form></Dialog>
  </main>;
}
