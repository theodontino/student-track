"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Dialog, EmptyState, Input, Section, Select, StatusBanner, Textarea } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { parseLessonFeedbackMaterial, type LessonFeedbackMaterial } from "@/lib/feedback-materials";

interface SemesterClass { id: string; code: string; name: string | null; }
interface SemesterSession { id: string; code: string; date: string; semesterNumber: number; class: { id?: string; code: string; name: string | null } | null; }
interface SessionLink { id: string; sessionId: string; syncStatus: string; differenceSummary: string | null; comparable: boolean; session: SemesterSession; }
interface GroupLesson { id: string; title: string; sequence: number; revision: number; material: LessonFeedbackMaterial; hasUnconfirmedChanges: boolean; revisions: Array<{ id: string; revision: number; confirmedAt: string }>; sessionLinks: SessionLink[]; }
interface ClassGroup { id: string; name: string; leadClassId: string | null; leadClass: SemesterClass | null; memberships: Array<{ classId: string; class: SemesterClass }>; lessons: GroupLesson[]; }

const syncLabels: Record<string, string> = { synced: "完全同步", partially_synced: "部分同步", diverged: "存在偏离", not_applicable: "不适用" };

export function ClassGroupPanel({ semesterId, classes, sessions }: { semesterId: string; classes: SemesterClass[]; sessions: SemesterSession[] }) {
  const [groups, setGroups] = useState<ClassGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [groupDialog, setGroupDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ClassGroup | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupClassIds, setGroupClassIds] = useState<string[]>([]);
  const [leadClassId, setLeadClassId] = useState("");
  const [lessonDialog, setLessonDialog] = useState(false);
  const [lessonGroupId, setLessonGroupId] = useState("");
  const [editingLesson, setEditingLesson] = useState<GroupLesson | null>(null);
  const [lessonTitle, setLessonTitle] = useState("");
  const [lessonSequence, setLessonSequence] = useState(1);
  const [groupFeedbackRaw, setGroupFeedbackRaw] = useState("");
  const [assessmentBriefRaw, setAssessmentBriefRaw] = useState("");
  const [linkDialog, setLinkDialog] = useState(false);
  const [linkLesson, setLinkLesson] = useState<{ group: ClassGroup; lesson: GroupLesson } | null>(null);
  const [linkSessionId, setLinkSessionId] = useState("");
  const [syncStatus, setSyncStatus] = useState("synced");
  const [differenceSummary, setDifferenceSummary] = useState("");
  const [comparable, setComparable] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setGroups((await requestJson<{ groups: ClassGroup[] }>(`/api/semesters/${encodeURIComponent(semesterId)}/class-groups`)).groups); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取班级组失败"); }
    finally { setLoading(false); }
  }, [semesterId]);
  useEffect(() => { void load(); }, [load]);

  const assignedClassIds = useMemo(() => new Set(groups.flatMap((group) => group.memberships.map((item) => item.classId))), [groups]);

  function classProgress(group: ClassGroup, classId: string) {
    const completed = group.lessons.filter((lesson) => lesson.sessionLinks.some((link) => link.session.class?.id === classId));
    const latest = completed.at(-1);
    return latest ? `已到第 ${latest.sequence} 讲` : "尚未开始";
  }

  function openGroup(group?: ClassGroup) {
    setEditingGroup(group ?? null); setGroupName(group?.name ?? ""); setGroupClassIds(group?.memberships.map((item) => item.classId) ?? []); setLeadClassId(group?.leadClassId ?? ""); setError(""); setGroupDialog(true);
  }
  async function saveGroup(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      await requestJson(editingGroup ? `/api/class-groups/${encodeURIComponent(editingGroup.id)}` : `/api/semesters/${encodeURIComponent(semesterId)}/class-groups`, { method: editingGroup ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: groupName, classIds: groupClassIds, leadClassId }) });
      setGroupDialog(false); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存班级组失败"); }
    finally { setSaving(false); }
  }

  function openLesson(group: ClassGroup, lesson?: GroupLesson) {
    setLessonGroupId(group.id); setEditingLesson(lesson ?? null); setLessonTitle(lesson?.title ?? ""); setLessonSequence(lesson?.sequence ?? (group.lessons.at(-1)?.sequence ?? 0) + 1); setGroupFeedbackRaw(lesson?.material.groupFeedbackRaw ?? ""); setAssessmentBriefRaw(lesson?.material.assessmentBriefRaw ?? ""); setError(""); setLessonDialog(true);
  }
  async function saveLesson(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const path = editingLesson ? `/api/group-lessons/${encodeURIComponent(editingLesson.id)}` : `/api/class-groups/${encodeURIComponent(lessonGroupId)}/lessons`;
      await requestJson(path, { method: editingLesson ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: lessonTitle, sequence: lessonSequence, material: parseLessonFeedbackMaterial(groupFeedbackRaw, assessmentBriefRaw) }) });
      setLessonDialog(false); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存共同课失败"); }
    finally { setSaving(false); }
  }
  async function confirmLesson(lesson: GroupLesson) {
    setSaving(true); setError("");
    try { await requestJson(`/api/group-lessons/${encodeURIComponent(lesson.id)}/confirm`, { method: "POST" }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "确认共同课失败"); }
    finally { setSaving(false); }
  }

  function openLink(group: ClassGroup, lesson: GroupLesson) {
    setLinkLesson({ group, lesson }); setLinkSessionId(""); setSyncStatus("synced"); setDifferenceSummary(""); setComparable(true); setError(""); setLinkDialog(true);
  }
  const linkableSessions = useMemo(() => {
    if (!linkLesson) return [];
    const memberIds = new Set(linkLesson.group.memberships.map((item) => item.classId));
    const used = new Set(groups.flatMap((group) => group.lessons.flatMap((lesson) => lesson.sessionLinks.map((link) => link.sessionId))));
    return sessions.filter((session) => session.class?.id && memberIds.has(session.class.id) && !used.has(session.id));
  }, [groups, linkLesson, sessions]);
  async function saveLink(event: React.FormEvent) {
    event.preventDefault(); if (!linkLesson) return; setSaving(true); setError("");
    try {
      await requestJson(`/api/group-lessons/${encodeURIComponent(linkLesson.lesson.id)}/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: linkSessionId, syncStatus, differenceSummary: differenceSummary || undefined, comparable }) });
      setLinkDialog(false); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "关联课次失败"); }
    finally { setSaving(false); }
  }
  async function unlink(lessonId: string, sessionId: string) {
    setSaving(true); setError("");
    try { await requestJson(`/api/group-lessons/${encodeURIComponent(lessonId)}/sessions?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "移除课次关联失败"); }
    finally { setSaving(false); }
  }

  return <>
    <Section title="班级组与共同进度" description="主班推进第 N 讲共同课，其他班自动跟随；每个班的真实课次、评价和考勤仍保持独立。">
      {error && <StatusBanner tone="danger">{error}</StatusBanner>}
      <div className="class-group-toolbar"><Button onClick={() => openGroup()} disabled={classes.length === 0}>新建班级组</Button></div>
      {loading ? <p>正在读取共同课…</p> : groups.length === 0 ? <EmptyState title="暂无班级组" description="将同一学期的平行班放入一个组，随后建立共同课。" /> : <div className="class-group-list">{groups.map((group) => <article className="class-group-card" key={group.id}>
        <header><div><strong>{group.name}</strong><p>主班：{group.leadClass?.name ?? group.leadClass?.code ?? "待设置"} · 共同进度 {group.lessons.length ? `已推进到第 ${group.lessons.at(-1)?.sequence} 讲` : "尚未开始"}</p><p>{group.memberships.map((item) => `${item.class.name ?? item.class.code}：${classProgress(group, item.classId)}`).join(" · ")}</p></div><div><Button variant="ghost" uiSize="sm" onClick={() => openGroup(group)}>编辑组</Button><Button variant="secondary" uiSize="sm" onClick={() => openLesson(group)}>补建共同课</Button></div></header>
        {group.lessons.length === 0 ? <p className="class-group-muted">尚未建立共同课。</p> : <div className="group-lesson-list">{group.lessons.map((lesson) => <section className="group-lesson-card" key={lesson.id}>
          <div className="group-lesson-heading"><div><strong>第 {lesson.sequence} 讲 · {lesson.title}</strong><p>{lesson.revision > 0 ? `已确认修订 ${lesson.revision}` : "尚未确认"}{lesson.hasUnconfirmedChanges && lesson.revision > 0 ? " · 有待确认修改" : ""}</p></div><div><Button variant="ghost" uiSize="sm" onClick={() => openLesson(group, lesson)}>编辑材料</Button><Button variant="secondary" uiSize="sm" disabled={saving || !lesson.hasUnconfirmedChanges} onClick={() => void confirmLesson(lesson)}>确认修订</Button><Button uiSize="sm" onClick={() => openLink(group, lesson)}>关联课次</Button></div></div>
          {lesson.sessionLinks.length === 0 ? <p className="class-group-muted">尚未关联各班真实课次。</p> : <div className="semester-session-table-wrap"><table className="semester-session-table"><thead><tr><th>班级</th><th>课次</th><th>同步</th><th>可比较</th><th>差异</th><th>操作</th></tr></thead><tbody>{lesson.sessionLinks.map((link) => <tr key={link.id}><td>{link.session.class?.name ?? link.session.class?.code ?? "—"}</td><td>{link.session.code}</td><td>{syncLabels[link.syncStatus] ?? link.syncStatus}</td><td>{link.comparable ? "是" : "否"}</td><td>{link.differenceSummary || "—"}</td><td><Button variant="ghost" uiSize="sm" disabled={saving} onClick={() => void unlink(lesson.id, link.sessionId)}>移除</Button></td></tr>)}</tbody></table></div>}
        </section>)}</div>}
      </article>)}</div>}
    </Section>
    <Dialog open={groupDialog} title={editingGroup ? "编辑班级组" : "新建班级组"} onClose={() => { if (!saving) setGroupDialog(false); }}><form className="dialog-form" onSubmit={saveGroup}><label>组名<Input required value={groupName} onChange={(event) => setGroupName(event.target.value)} /></label><fieldset className="class-group-checkboxes"><legend>选择班级</legend>{classes.map((klass) => { const unavailable = assignedClassIds.has(klass.id) && !editingGroup?.memberships.some((item) => item.classId === klass.id); return <label key={klass.id}><input type="checkbox" disabled={unavailable} checked={groupClassIds.includes(klass.id)} onChange={(event) => { setGroupClassIds((current) => event.target.checked ? [...current, klass.id] : current.filter((id) => id !== klass.id)); if (!event.target.checked && leadClassId === klass.id) setLeadClassId(""); }} />{klass.name ?? klass.code}{unavailable ? "（已在其他组）" : ""}</label>; })}</fieldset><label>主班<Select required value={leadClassId} onChange={(event) => setLeadClassId(event.target.value)}><option value="">请选择负责推进共同进度的班级</option>{classes.filter((klass) => groupClassIds.includes(klass.id)).map((klass) => <option key={klass.id} value={klass.id}>{klass.name ?? klass.code}</option>)}</Select></label><p className="class-group-muted">主班每次新建课次会推进下一讲；其他班自动补齐主班已经开始的最早一讲。</p><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setGroupDialog(false)}>取消</Button><Button type="submit" disabled={saving || groupClassIds.length === 0 || !leadClassId}>{saving ? "保存中…" : "保存"}</Button></div></form></Dialog>
    <Dialog open={lessonDialog} title={editingLesson ? "编辑共同课" : "新建共同课"} onClose={() => { if (!saving) setLessonDialog(false); }}><form className="dialog-form" onSubmit={saveLesson}><label>讲次<Input type="number" min={1} value={lessonSequence} onChange={(event) => setLessonSequence(Number(event.target.value))} /></label><label>标题<Input required value={lessonTitle} onChange={(event) => setLessonTitle(event.target.value)} /></label><label>班级公共反馈或课程材料<Textarea rows={7} value={groupFeedbackRaw} onChange={(event) => setGroupFeedbackRaw(event.target.value)} /></label><label>统一测评说明<Textarea rows={5} value={assessmentBriefRaw} onChange={(event) => setAssessmentBriefRaw(event.target.value)} /></label><p className="class-group-muted">保存只是草稿；点击“确认修订”后，组内各班的单班反馈可以继承这份课程背景。</p><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setLessonDialog(false)}>取消</Button><Button type="submit" disabled={saving}>{saving ? "保存中…" : "保存草稿"}</Button></div></form></Dialog>
    <Dialog open={linkDialog} title="关联真实课次" onClose={() => { if (!saving) setLinkDialog(false); }}><form className="dialog-form" onSubmit={saveLink}><label>课次<Select required value={linkSessionId} onChange={(event) => setLinkSessionId(event.target.value)}><option value="">请选择</option>{linkableSessions.map((session) => <option value={session.id} key={session.id}>{session.class?.name ?? session.class?.code} · {session.code}</option>)}</Select></label><label>同步状态<Select value={syncStatus} onChange={(event) => setSyncStatus(event.target.value)}>{Object.entries(syncLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</Select></label>{syncStatus !== "synced" && <label>差异说明<Textarea required rows={4} value={differenceSummary} onChange={(event) => setDifferenceSummary(event.target.value)} /></label>}<label className="class-group-inline-check"><input type="checkbox" checked={comparable && syncStatus !== "not_applicable"} disabled={syncStatus === "not_applicable"} onChange={(event) => setComparable(event.target.checked)} />允许跨班比较</label><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setLinkDialog(false)}>取消</Button><Button type="submit" disabled={saving || !linkSessionId}>{saving ? "保存中…" : "确认关联"}</Button></div></form></Dialog>
  </>;
}
