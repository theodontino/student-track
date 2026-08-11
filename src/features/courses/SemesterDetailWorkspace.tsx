"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, Dialog, EmptyState, ErrorState, Input, LoadingState, MetricCard, PageHeader, Section, StatusBanner } from "@/components/ui";
import { downloadFile, requestJson } from "@/lib/api-client";

interface Session { id: string; code: string; date: string; semesterNumber: number; class: { code: string; name: string | null } | null; _count: { attendances: number }; }
interface SemesterClass { id: string; code: string; name: string | null; activeStudentCount: number; inactiveStudentCount: number; sessionCount: number; }
interface SemesterDetail { id: string; name: string; startDate: string; endDate: string; sessions: Session[]; classes: SemesterClass[]; sessionCount: number; totalStudents: number; attendances: number; }

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
  const load = useCallback(async () => { setLoading(true); setError(""); try { setSemester(await requestJson<SemesterDetail>(`/api/semesters/${params.id}`)); } catch (reason) { setError(reason instanceof Error ? reason.message : "加载学期详情失败"); } finally { setLoading(false); } }, [params.id]);
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
    try {
      await downloadFile(`/api/classes/${encodeURIComponent(klass.id)}/step-roster`, `${klass.code}.step-roster.json`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出 STEP 花名册失败");
    } finally {
      setExportingClassId(null);
    }
  }
  if (loading) return <LoadingState label="正在加载学期详情…" />;
  if (error) return <ErrorState message={error} action={<Button onClick={() => void load()}>重试</Button>} />;
  if (!semester) return <EmptyState title="学期不存在" />;
  return <main className="semester-detail-workspace"><PageHeader title={semester.name} description={`${semester.startDate} → ${semester.endDate}`} actions={<div className="semester-detail-actions"><Button variant="secondary" onClick={() => router.push(`/students?semesterId=${encodeURIComponent(semester.id)}`)}>导入花名册</Button><Button onClick={() => openClassDialog()}>新建班级</Button></div>} /><div className="semester-metrics"><MetricCard label="课次总数" value={semester.sessionCount} tone="brand" /><MetricCard label="学生总数" value={semester.totalStudents} tone="success" /><MetricCard label="考勤记录总数" value={semester.attendances} tone="warning" /></div><Section title="班级列表" description="班级编号只在本学期内唯一；不同学期可以复用同一编号。">{semester.classes.length === 0 ? <EmptyState title="暂无班级" description="先创建班级或从学生页导入本学期花名册。" action={<Button onClick={() => openClassDialog()}>新建班级</Button>} /> : <div className="semester-session-table-wrap"><table className="semester-session-table"><thead><tr><th>班级编号</th><th>班级名称</th><th>在读人数</th><th>非活跃人数</th><th>课次数</th><th>操作</th></tr></thead><tbody>{semester.classes.map((klass) => <tr key={klass.id}><td>{klass.code}</td><td>{klass.name ?? "—"}</td><td>{klass.activeStudentCount}</td><td>{klass.inactiveStudentCount}</td><td>{klass.sessionCount}</td><td><Button variant="ghost" uiSize="sm" onClick={() => openClassDialog(klass)}>编辑</Button>{" "}<Button variant="ghost" uiSize="sm" onClick={() => void exportStepRoster(klass)} disabled={exportingClassId !== null}>{exportingClassId === klass.id ? "导出中…" : "导出到 STEP"}</Button></td></tr>)}</tbody></table></div>}</Section><Section title="课次列表" description="按日期查看学期内已经建立的课次。">{semester.sessions.length === 0 ? <EmptyState title="暂无课次记录" /> : <div className="semester-session-table-wrap"><table className="semester-session-table"><thead><tr><th>课次编码</th><th>日期</th><th>学期序号</th><th>班级</th><th>考勤人数</th></tr></thead><tbody>{semester.sessions.map((session) => <tr key={session.id}><td>{session.code}</td><td>{session.date}</td><td>第 {session.semesterNumber} 次</td><td>{session.class ? (session.class.name ?? session.class.code) : "全校"}</td><td>{session._count.attendances}</td></tr>)}</tbody></table></div>}</Section><Dialog open={classDialogOpen} title={editingClass ? "编辑班级" : "新建班级"} onClose={() => { if (!savingClass) setClassDialogOpen(false); }}><form onSubmit={saveClass} className="dialog-form">{classError && <StatusBanner tone="danger">{classError}</StatusBanner>}<label>班级编号<Input required value={classCode} onChange={(event) => setClassCode(event.target.value)} /></label><label>班级名称<Input value={className} onChange={(event) => setClassName(event.target.value)} /></label><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setClassDialogOpen(false)} disabled={savingClass}>取消</Button><Button type="submit" disabled={savingClass}>{savingClass ? "保存中…" : "保存班级"}</Button></div></form></Dialog></main>;
}
