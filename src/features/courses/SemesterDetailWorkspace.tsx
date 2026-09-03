"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button, Dialog, EmptyState, ErrorState, Input, LoadingState, MetricCard, PageHeader, Section, StatusBanner } from "@/components/ui";
import { ClassGroupPanel } from "@/features/courses/ClassGroupPanel";
import { SessionDialog } from "@/features/courses/SessionDialog";
import { downloadFile, requestJson } from "@/lib/api-client";
import type { FeedbackScriptLibraryResponse } from "@/lib/feedback-script-library";

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
interface RecycleImpact { kind: "class" | "semester"; id: string; name: string; sessionCount: number; batchCount: number; factCount: number; intakeRunCount: number; planCount?: number; directPlanCount?: number; affectedPlanCount?: number; classCount?: number; }
interface FactsImpact { session: { id: string; code: string }; metricCount: number; attendanceCount: number; eventCount: number; teacherHandlingCount: number; intakeRunCount: number; draftCount: number; preserved: { communications: number; feedbackPlans: number; commonMaterial: boolean; groupLessonLink: boolean }; }

function summarizeMaterial(value: string, fallback = "—") {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 80 ? `${normalized.slice(0, 80)}…` : normalized;
}

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
  const [sessionError, setSessionError] = useState("");
  const [progressSession, setProgressSession] = useState<Session | null>(null);
  const [progressChoice, setProgressChoice] = useState("");
  const [progressLessons, setProgressLessons] = useState<Array<{ id: string; sequence: number; title: string }>>([]);
  const [progressGroupName, setProgressGroupName] = useState("");
  const [savingProgress, setSavingProgress] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "class" | "semester"; id: string; name: string } | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<RecycleImpact | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [factsTarget, setFactsTarget] = useState<Session | null>(null);
  const [factsImpact, setFactsImpact] = useState<FactsImpact | null>(null);
  const [clearingFacts, setClearingFacts] = useState(false);
  const [scriptLibrary, setScriptLibrary] = useState<FeedbackScriptLibraryResponse>({ library: null, recommendedLessonNumber: null });
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [libraryNotice, setLibraryNotice] = useState("");
  const [importingLibrary, setImportingLibrary] = useState(false);
  const [pendingLibraryFile, setPendingLibraryFile] = useState<File | null>(null);
  const libraryFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setSemester(await requestJson<SemesterDetail>(`/api/semesters/${params.id}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "加载学期详情失败"); }
    finally { setLoading(false); }
  }, [params.id]);
  useEffect(() => { void load(); }, [load]);

  const loadScriptLibrary = useCallback(async () => {
    setLoadingLibrary(true);
    setLibraryError("");
    try {
      setScriptLibrary(await requestJson<FeedbackScriptLibraryResponse>(`/api/feedback/script-library?semesterId=${encodeURIComponent(String(params.id))}`));
    } catch (reason) {
      setLibraryError(reason instanceof Error ? reason.message : "读取学期公共材料失败");
    } finally {
      setLoadingLibrary(false);
    }
  }, [params.id]);
  useEffect(() => { void loadScriptLibrary(); }, [loadScriptLibrary]);

  useEffect(() => {
    if (!semester || window.location.hash !== "#semester-common-materials") return;
    window.requestAnimationFrame(() => document.getElementById("semester-common-materials")?.scrollIntoView());
  }, [semester]);

  async function uploadScriptLibrary(file: File, replaceExisting: boolean) {
    setImportingLibrary(true);
    setLibraryError("");
    setLibraryNotice("");
    try {
      const formData = new FormData();
      formData.set("semesterId", String(params.id));
      formData.set("file", file);
      if (replaceExisting) formData.set("replaceExisting", "true");
      const response = await requestJson<FeedbackScriptLibraryResponse>("/api/feedback/script-library", {
        method: "POST",
        body: formData,
      });
      setScriptLibrary(response);
      setPendingLibraryFile(null);
      setLibraryNotice(replaceExisting ? "学期公共材料库已整体替换。已有共同讲次和历史快照没有改变。" : "学期公共材料库已导入。");
    } catch (reason) {
      setLibraryError(reason instanceof Error ? reason.message : "导入学期公共材料失败");
    } finally {
      setImportingLibrary(false);
      if (libraryFileRef.current) libraryFileRef.current.value = "";
    }
  }

  function chooseScriptLibrary(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.name.split(".").pop()?.toLowerCase() !== "xlsx") {
      setLibraryNotice("");
      setLibraryError("仅支持 .xlsx 文件");
      event.target.value = "";
      return;
    }
    if (scriptLibrary.library) {
      setPendingLibraryFile(file);
      return;
    }
    void uploadScriptLibrary(file, false);
  }

  async function downloadScriptLibraryTemplate() {
    setLibraryError("");
    try {
      await downloadFile("/api/feedback/script-library/template", "semester-common-material-template.xlsx");
    } catch (reason) {
      setLibraryError(reason instanceof Error ? reason.message : "下载导入模板失败");
    }
  }

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

  async function prepareDelete(kind: "class" | "semester", id: string, name: string) {
    setSessionError(""); setDeleteTarget({ kind, id, name }); setDeleteImpact(null);
    try { setDeleteImpact(await requestJson<RecycleImpact>(`/api/recycle-bin/impact?kind=${kind}&id=${encodeURIComponent(id)}`)); }
    catch (reason) { setSessionError(reason instanceof Error ? reason.message : "读取删除影响失败"); setDeleteTarget(null); }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await requestJson(`/api/${deleteTarget.kind === "semester" ? "semesters" : "classes"}/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
      if (deleteTarget.kind === "semester") { router.push("/semesters"); return; }
      setDeleteTarget(null); await load();
    } catch (reason) { setSessionError(reason instanceof Error ? reason.message : "移入回收站失败"); }
    finally { setDeleting(false); }
  }

  async function prepareClearFacts(session: Session) {
    setSessionError(""); setFactsTarget(session); setFactsImpact(null);
    try { setFactsImpact(await requestJson<FactsImpact>(`/api/sessions/${encodeURIComponent(session.id)}/facts`)); }
    catch (reason) { setSessionError(reason instanceof Error ? reason.message : "读取课次事实失败"); setFactsTarget(null); }
  }

  async function confirmClearFacts() {
    if (!factsTarget) return;
    setClearingFacts(true);
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(factsTarget.id)}/facts`, { method: "DELETE" });
      setFactsTarget(null); await load();
    } catch (reason) { setSessionError(reason instanceof Error ? reason.message : "清空课次事实失败"); }
    finally { setClearingFacts(false); }
  }

  if (loading) return <LoadingState label="正在加载学期详情…" />;
  if (error) return <ErrorState message={error} action={<Button onClick={() => void load()}>重试</Button>} />;
  if (!semester) return <EmptyState title="学期不存在" />;

  return <main className="semester-detail-workspace">
    <PageHeader
      title={semester.name}
      description={`${semester.startDate} → ${semester.endDate}`}
      actions={<div className="semester-detail-actions"><Button variant="danger" onClick={() => void prepareDelete("semester", semester.id, semester.name)}>删除学期</Button><Button variant="secondary" onClick={() => router.push(`/students?semesterId=${encodeURIComponent(semester.id)}`)}>导入花名册</Button><Button onClick={() => openClassDialog()}>新建班级</Button></div>}
    />
    <div className="semester-metrics"><MetricCard label="课次总数" value={semester.sessionCount} tone="brand" /><MetricCard label="学生总数" value={semester.totalStudents} tone="success" /><MetricCard label="考勤记录总数" value={semester.attendances} tone="warning" /></div>
    <Section title="班级列表" description="班级编号只在本学期内唯一；不同学期可以复用同一编号。">
      {semester.classes.length === 0 ? <EmptyState title="暂无班级" description="先创建班级或从学生页导入本学期花名册。" action={<Button onClick={() => openClassDialog()}>新建班级</Button>} /> : <div className="semester-session-table-wrap"><table className="semester-session-table"><thead><tr><th>班级编号</th><th>班级名称</th><th>在读人数</th><th>非活跃人数</th><th>课次数</th><th>操作</th></tr></thead><tbody>{semester.classes.map((klass) => <tr key={klass.id}><td>{klass.code}</td><td>{klass.name ?? "—"}</td><td>{klass.activeStudentCount}</td><td>{klass.inactiveStudentCount}</td><td>{klass.sessionCount}</td><td><Button variant="ghost" uiSize="sm" onClick={() => openClassDialog(klass)}>编辑</Button>{" "}<Button variant="ghost" uiSize="sm" onClick={() => void exportStepRoster(klass)} disabled={exportingClassId !== null}>{exportingClassId === klass.id ? "导出中…" : "导出到 STEP"}</Button>{" "}<Button variant="danger" uiSize="sm" onClick={() => void prepareDelete("class", klass.id, klass.name ?? klass.code)}>删除</Button></td></tr>)}</tbody></table></div>}
    </Section>
    <div id="semester-common-materials" className="semester-common-materials">
      <Section
        title="学期公共材料"
        description="一个学期只保留一套规范化材料库。建立新共同讲次时，会按相同课次复制为待确认草稿；已有讲次不会自动覆盖。"
        actions={<div className="semester-detail-actions"><Button variant="secondary" onClick={() => void downloadScriptLibraryTemplate()}>下载导入模板</Button><Button onClick={() => libraryFileRef.current?.click()} disabled={importingLibrary}>{importingLibrary ? "导入中…" : scriptLibrary.library ? "选择文件并整体替换" : "导入 .xlsx"}</Button><input ref={libraryFileRef} className="semester-material-file-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={chooseScriptLibrary} /></div>}
      >
        {libraryError && <StatusBanner tone="danger">{libraryError}</StatusBanner>}
        {libraryNotice && <StatusBanner tone="success">{libraryNotice}</StatusBanner>}
        {loadingLibrary ? <LoadingState label="正在读取学期公共材料…" /> : !scriptLibrary.library ? <EmptyState title="尚未导入学期公共材料" description="请先下载模板，按课次填写后上传 .xlsx。首次导入会直接保存；以后替换整套材料前会再次确认。" /> : <>
          <div className="semester-material-overview"><div><span>材料库名称</span><strong>{scriptLibrary.library.name}</strong></div><div><span>更新时间</span><strong>{new Date(scriptLibrary.library.updatedAt).toLocaleString("zh-CN")}</strong></div><div><span>已识别课次</span><strong>{scriptLibrary.library.entries.length}</strong></div></div>
          {scriptLibrary.library.warnings.length > 0 && <StatusBanner tone="warning"><strong>导入警告</strong><ul>{scriptLibrary.library.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></StatusBanner>}
          <div className="semester-session-table-wrap"><table className="semester-session-table semester-material-table"><thead><tr><th>课次</th><th>课程主题</th><th>群反馈摘要</th><th>统一测评摘要</th><th>私反馈模板摘要</th></tr></thead><tbody>{scriptLibrary.library.entries.map((entry) => <tr key={entry.lessonNumber}><td>第 {entry.lessonNumber} 课</td><td><strong>{entry.topic || entry.material?.lessonTitle || "—"}</strong>{entry.note && <small>备注：{summarizeMaterial(entry.note)}</small>}</td><td>{summarizeMaterial(entry.groupFeedback)}</td><td>{summarizeMaterial(entry.material?.assessmentBriefRaw ?? "")}</td><td><span>全对：{summarizeMaterial(entry.perfectPrivateFeedback)}</span><small>有错误：{summarizeMaterial(entry.errorPrivateFeedback)}</small></td></tr>)}</tbody></table></div>
        </>}
      </Section>
    </div>
    <ClassGroupPanel semesterId={semester.id} classes={semester.classes} sessions={semester.sessions} />
    <Section title="课次列表" description="真实课次属于具体班级；班级组共同进度只说明本班正在完成第几讲。" actions={<Button onClick={() => { setSessionError(""); setSessionDialogOpen(true); }} disabled={semester.classes.length === 0}>新建课次</Button>}>
      {sessionError && !sessionDialogOpen && !progressSession && <StatusBanner tone="danger">{sessionError}</StatusBanner>}
      {semester.sessions.length === 0 ? <EmptyState title="暂无课次记录" /> : <div className="semester-session-table-wrap"><table className="semester-session-table"><thead><tr><th>课次编码</th><th>日期</th><th>学期序号</th><th>班级</th><th>班级组进度</th><th>考勤人数</th><th>操作</th></tr></thead><tbody>{semester.sessions.map((session) => <tr key={session.id}><td>{session.code}</td><td>{session.date}</td><td>第 {session.semesterNumber} 次</td><td>{session.class ? (session.class.name ?? session.class.code) : "全校"}</td><td>{session.groupLessonSession?.groupLesson ? `第 ${session.groupLessonSession.groupLesson.sequence} 讲 · ${session.groupLessonSession.groupLesson.title}` : "独立课次"}</td><td>{session._count.attendances}</td><td><Button variant="ghost" uiSize="sm" onClick={() => void openProgress(session)} disabled={!session.class}>调整共同进度</Button>{" "}<Button variant="danger" uiSize="sm" onClick={() => void prepareClearFacts(session)}>清空事实</Button></td></tr>)}</tbody></table></div>}
    </Section>
    <Dialog open={classDialogOpen} title={editingClass ? "编辑班级" : "新建班级"} onClose={() => { if (!savingClass) setClassDialogOpen(false); }}>
      <form onSubmit={saveClass} className="dialog-form">{classError && <StatusBanner tone="danger">{classError}</StatusBanner>}<label>班级编号<Input required value={classCode} onChange={(event) => setClassCode(event.target.value)} /></label><label>班级名称<Input value={className} onChange={(event) => setClassName(event.target.value)} /></label><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setClassDialogOpen(false)} disabled={savingClass}>取消</Button><Button type="submit" disabled={savingClass}>{savingClass ? "保存中…" : "保存班级"}</Button></div></form>
    </Dialog>
    <SessionDialog open={sessionDialogOpen} semesterId={semester.id} classes={semester.classes} onClose={() => setSessionDialogOpen(false)} onSaved={async () => { await load(); }} />
    <Dialog open={Boolean(progressSession)} title="调整班级组共同进度" onClose={() => { if (!savingProgress) setProgressSession(null); }}><form className="dialog-form" onSubmit={saveProgress}>{sessionError && <StatusBanner tone="danger">{sessionError}</StatusBanner>}<p className="dialog-form__hint">{progressGroupName} · {progressSession?.class?.name ?? progressSession?.class?.code} · {progressSession?.code}</p><label>对应共同课<select value={progressChoice} onChange={(event) => setProgressChoice(event.target.value)}><option value="">设为独立课次</option>{progressLessons.map((lesson) => <option key={lesson.id} value={lesson.id}>第 {lesson.sequence} 讲 · {lesson.title}</option>)}</select></label><p className="dialog-form__hint">调整只改变共同进度关系，不移动或合并本课的评分、考勤和事件。</p><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setProgressSession(null)}>取消</Button><Button type="submit" disabled={savingProgress}>{savingProgress ? "保存中…" : "保存调整"}</Button></div></form></Dialog>
    <Dialog open={Boolean(deleteTarget)} title={`删除${deleteTarget?.kind === "semester" ? "学期" : "班级"}`} onClose={() => { if (!deleting) setDeleteTarget(null); }}><div className="dialog-form">{sessionError && <StatusBanner tone="danger">{sessionError}</StatusBanner>}{!deleteImpact ? <LoadingState label="正在统计影响…" /> : <><StatusBanner tone="warning">删除后 30 天内可以恢复；期间该范围不可用。运行中的生成会先暂停。</StatusBanner><p><strong>{deleteTarget?.name}</strong>：{deleteImpact.classCount !== undefined ? `${deleteImpact.classCount} 个班级、` : ""}{deleteImpact.sessionCount} 个课次、{deleteImpact.affectedPlanCount ?? deleteImpact.planCount ?? deleteImpact.directPlanCount ?? 0} 份受影响计划。</p>{deleteImpact.batchCount > 0 && <StatusBanner tone="danger">其中 {deleteImpact.batchCount} 份多班计划会连同所有班级结果整体停用；到期时整份清除。</StatusBanner>}<p className="dialog-form__hint">原始 ID 与关联数据在恢复期内保留。恢复后，原本手动归档的计划仍保持归档。</p></>}<div className="dialog-form__actions"><Button variant="secondary" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</Button><Button variant="danger" onClick={() => void confirmDelete()} disabled={deleting || !deleteImpact}>{deleting ? "正在移入…" : "移入回收站"}</Button></div></div></Dialog>
    <Dialog open={Boolean(factsTarget)} title="清空课次已录入事实" onClose={() => { if (!clearingFacts) setFactsTarget(null); }}><div className="dialog-form">{sessionError && <StatusBanner tone="danger">{sessionError}</StatusBanner>}{!factsImpact ? <LoadingState label="正在统计事实…" /> : <><StatusBanner tone="danger">此操作会先创建并校验数据库备份，然后清空当前事实。计划快照与已经生成的反馈不会改变。</StatusBanner><p><strong>{factsImpact.session.code}</strong> 将清除：评分 {factsImpact.metricCount}、考勤 {factsImpact.attendanceCount}、事件 {factsImpact.eventCount}（其中教师处理 {factsImpact.teacherHandlingCount}）、录入运行 {factsImpact.intakeRunCount}。</p><p className="dialog-form__hint">保留 {factsImpact.preserved.communications} 条沟通、{factsImpact.preserved.feedbackPlans} 份计划，以及公共材料和共同课关联。清空后可重新上传同一文件。</p></>}<div className="dialog-form__actions"><Button variant="secondary" onClick={() => setFactsTarget(null)} disabled={clearingFacts}>取消</Button><Button variant="danger" onClick={() => void confirmClearFacts()} disabled={clearingFacts || !factsImpact}>{clearingFacts ? "正在备份并清空…" : "确认清空事实"}</Button></div></div></Dialog>
    <Dialog open={Boolean(pendingLibraryFile)} title="整体替换学期公共材料" onClose={() => { if (!importingLibrary) { setPendingLibraryFile(null); if (libraryFileRef.current) libraryFileRef.current.value = ""; } }}><div className="dialog-form"><StatusBanner tone="warning">当前学期已有公共材料库。确认后会用新文件中的规范化内容整体替换旧库。</StatusBanner><p>已有共同讲次不会自动覆盖；确认修订、真实课次快照和反馈计划快照也不会改变。需要更新某个已有讲次时，请在该讲次中单独选择“重新套用同号材料”。</p><div className="dialog-form__actions"><Button variant="secondary" onClick={() => { setPendingLibraryFile(null); if (libraryFileRef.current) libraryFileRef.current.value = ""; }} disabled={importingLibrary}>取消</Button><Button variant="danger" onClick={() => { if (pendingLibraryFile) void uploadScriptLibrary(pendingLibraryFile, true); }} disabled={importingLibrary}>{importingLibrary ? "正在替换…" : "确认整体替换"}</Button></div></div></Dialog>
  </main>;
}
