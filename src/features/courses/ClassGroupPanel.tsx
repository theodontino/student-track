"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmDialog, Dialog, EmptyState, Input, Section, Select, StatusBanner, Textarea } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import {
  lessonMaterialHasContent,
  parseLessonFeedbackMaterial,
  type LessonFeedbackMaterial,
} from "@/lib/feedback-materials";

interface SemesterClass { id: string; code: string; name: string | null; }
interface SemesterSession { id: string; code: string; date: string; semesterNumber: number; class: { id?: string; code: string; name: string | null } | null; }
interface SessionLink { id: string; sessionId: string; syncStatus: string; differenceSummary: string | null; comparable: boolean; session: SemesterSession; }
interface GroupLesson { id: string; title: string; sequence: number; revision: number; material: LessonFeedbackMaterial; hasUnconfirmedChanges: boolean; revisions: Array<{ id: string; revision: number; confirmedAt: string }>; sessionLinks: SessionLink[]; }
interface ClassGroup { id: string; name: string; leadClassId: string | null; leadClass: SemesterClass | null; memberships: Array<{ classId: string; class: SemesterClass }>; lessons: GroupLesson[]; }

type LinkTarget =
  | { kind: "matrix-cell"; group: ClassGroup; lesson: GroupLesson; classId: string }
  | { kind: "independent-session"; group: ClassGroup; session: SemesterSession };

const syncLabels: Record<string, string> = { synced: "完全同步", partially_synced: "部分同步", diverged: "存在偏离", not_applicable: "不适用" };

function classLabel(klass: SemesterClass | SemesterSession["class"]) {
  return klass?.name ?? klass?.code ?? "未知班级";
}

function linkClassId(link: SessionLink) {
  return link.session.class?.id ?? "";
}

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
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  const [linkSessionId, setLinkSessionId] = useState("");
  const [linkLessonId, setLinkLessonId] = useState("");
  const [deletingLesson, setDeletingLesson] = useState<GroupLesson | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<ClassGroup | null>(null);
  const [saving, setSaving] = useState(false);
  const loadVersionRef = useRef(0);

  const load = useCallback(async () => {
    const loadVersion = ++loadVersionRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await requestJson<{ groups: ClassGroup[] }>(`/api/semesters/${encodeURIComponent(semesterId)}/class-groups`);
      if (loadVersionRef.current === loadVersion) setGroups(response.groups);
    } catch (reason) {
      if (loadVersionRef.current === loadVersion) {
        setError(reason instanceof Error ? reason.message : "读取班级组失败");
      }
    } finally {
      if (loadVersionRef.current === loadVersion) setLoading(false);
    }
  }, [semesterId]);

  useEffect(() => {
    void load();
    return () => { loadVersionRef.current += 1; };
  }, [load, sessions]);

  const assignedClassIds = useMemo(
    () => new Set(groups.flatMap((group) => group.memberships.map((item) => item.classId))),
    [groups],
  );
  const usedSessionIds = useMemo(
    () => new Set(groups.flatMap((group) => group.lessons.flatMap((lesson) => lesson.sessionLinks.map((link) => link.sessionId)))),
    [groups],
  );

  function independentSessions(group: ClassGroup) {
    const memberIds = new Set(group.memberships.map((item) => item.classId));
    return sessions
      .filter((session) => session.class?.id && memberIds.has(session.class.id) && !usedSessionIds.has(session.id))
      .sort((left, right) => right.date.localeCompare(left.date) || right.semesterNumber - left.semesterNumber);
  }

  function openGroup(group?: ClassGroup) {
    setEditingGroup(group ?? null);
    setGroupName(group?.name ?? "");
    setGroupClassIds(group?.memberships.map((item) => item.classId) ?? []);
    setLeadClassId(group?.leadClassId ?? "");
    setError("");
    setGroupDialog(true);
  }

  async function saveGroup(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await requestJson(
        editingGroup ? `/api/class-groups/${encodeURIComponent(editingGroup.id)}` : `/api/semesters/${encodeURIComponent(semesterId)}/class-groups`,
        {
          method: editingGroup ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: groupName, classIds: groupClassIds, leadClassId }),
        },
      );
      setGroupDialog(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存班级组失败");
    } finally {
      setSaving(false);
    }
  }

  function openLesson(group: ClassGroup, lesson?: GroupLesson) {
    const nextSequence = (group.lessons.at(-1)?.sequence ?? 0) + 1;
    setLessonGroupId(group.id);
    setEditingLesson(lesson ?? null);
    setLessonTitle(lesson?.title ?? `第 ${nextSequence} 讲`);
    setLessonSequence(lesson?.sequence ?? nextSequence);
    setGroupFeedbackRaw(lesson?.material.groupFeedbackRaw ?? "");
    setAssessmentBriefRaw(lesson?.material.assessmentBriefRaw ?? "");
    setError("");
    setLessonDialog(true);
  }

  async function saveLesson(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const path = editingLesson
        ? `/api/group-lessons/${encodeURIComponent(editingLesson.id)}`
        : `/api/class-groups/${encodeURIComponent(lessonGroupId)}/lessons`;
      await requestJson(path, {
        method: editingLesson ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: lessonTitle,
          sequence: lessonSequence,
          material: parseLessonFeedbackMaterial(groupFeedbackRaw, assessmentBriefRaw),
        }),
      });
      setLessonDialog(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存共同课失败");
    } finally {
      setSaving(false);
    }
  }

  async function confirmLesson(lesson: GroupLesson) {
    setSaving(true);
    setError("");
    try {
      await requestJson(`/api/group-lessons/${encodeURIComponent(lesson.id)}/confirm`, { method: "POST" });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "确认共同课失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteLesson() {
    if (!deletingLesson) return;
    setSaving(true);
    setError("");
    try {
      await requestJson(`/api/group-lessons/${encodeURIComponent(deletingLesson.id)}`, { method: "DELETE" });
      setDeletingLesson(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除空讲次失败");
      setDeletingLesson(null);
    } finally {
      setSaving(false);
    }
  }

  async function deleteGroup() {
    if (!deletingGroup) return;
    setSaving(true);
    setError("");
    try {
      await requestJson(`/api/class-groups/${encodeURIComponent(deletingGroup.id)}`, { method: "DELETE" });
      setDeletingGroup(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除班级组失败");
      setDeletingGroup(null);
    } finally {
      setSaving(false);
    }
  }

  function openMatrixLink(group: ClassGroup, lesson: GroupLesson, classId: string) {
    setLinkTarget({ kind: "matrix-cell", group, lesson, classId });
    setLinkLessonId(lesson.id);
    setLinkSessionId("");
    setError("");
  }

  function openIndependentLink(group: ClassGroup, session: SemesterSession) {
    setLinkTarget({ kind: "independent-session", group, session });
    setLinkLessonId("");
    setLinkSessionId(session.id);
    setError("");
  }

  const linkableSessions = useMemo(() => {
    if (!linkTarget || linkTarget.kind !== "matrix-cell") return [];
    return sessions
      .filter((session) => session.class?.id === linkTarget.classId && !usedSessionIds.has(session.id))
      .sort((left, right) => right.date.localeCompare(left.date) || right.semesterNumber - left.semesterNumber);
  }, [linkTarget, sessions, usedSessionIds]);

  const linkableLessons = useMemo(() => {
    if (!linkTarget || linkTarget.kind !== "independent-session") return [];
    const classId = linkTarget.session.class?.id;
    if (!classId) return [];
    return linkTarget.group.lessons.filter((lesson) => (
      !lesson.sessionLinks.some((link) => linkClassId(link) === classId)
    ));
  }, [linkTarget]);

  async function saveLink(event: React.FormEvent) {
    event.preventDefault();
    if (!linkTarget || !linkSessionId || !linkLessonId) return;
    setSaving(true);
    setError("");
    try {
      await requestJson(`/api/group-lessons/${encodeURIComponent(linkLessonId)}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: linkSessionId, syncStatus: "synced", comparable: true }),
      });
      setLinkTarget(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "关联课次失败");
    } finally {
      setSaving(false);
    }
  }

  async function unlink(lessonId: string, sessionId: string) {
    setSaving(true);
    setError("");
    try {
      await requestJson(`/api/group-lessons/${encodeURIComponent(lessonId)}/sessions?sessionId=${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "解除课次关联失败");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <Section
      title="共同讲次与班级课次"
      description="一行是一讲，一列是一个班。先看哪里缺课次，再处理补课或关联；评分、考勤和事件始终留在各班真实课次。"
      actions={<Button onClick={() => openGroup()} disabled={classes.length === 0}>新建班级组</Button>}
    >
      {error && <StatusBanner tone="danger">{error}</StatusBanner>}
      {loading ? <p>正在读取共同进度…</p> : groups.length === 0 ? (
        <EmptyState title="暂无班级组" description="把共享课程进度的平行班放进同一个组，并指定进度基准班。" />
      ) : (
        <div className="class-group-list">{groups.map((group) => {
          const currentMemberIds = new Set(group.memberships.map((item) => item.classId));
          const unlinkedSessions = independentSessions(group);
          const allLinks = group.lessons.flatMap((lesson) => lesson.sessionLinks.map((link) => ({ lesson, link })));
          const historicalLinkCount = allLinks.filter(({ link }) => !currentMemberIds.has(linkClassId(link))).length;

          return <article className="class-group-card" key={group.id}>
            <header className="class-group-card__header">
              <div>
                <div className="class-group-card__title"><strong>{group.name}</strong><span>{group.memberships.length} 个班</span></div>
                <p>进度基准班：{classLabel(group.leadClass)} · {group.lessons.length ? `已建立 ${group.lessons.length} 讲` : "还没有共同讲次"}</p>
              </div>
              <Button onClick={() => openLesson(group)}>建立下一讲</Button>
            </header>

            <div className="class-group-matrix-wrap">
              <table className="class-group-matrix">
                <thead><tr><th>共同讲次</th>{group.memberships.map((membership) => (
                  <th key={membership.classId}>{classLabel(membership.class)}{membership.classId === group.leadClassId && <span className="class-group-lead-badge">进度基准</span>}</th>
                ))}</tr></thead>
                <tbody>{group.lessons.length === 0 ? (
                  <tr><td className="class-group-matrix__empty" colSpan={group.memberships.length + 1}>点击“建立下一讲”，再把各班真实课次放到同一行。</td></tr>
                ) : group.lessons.map((lesson) => (
                  <tr key={lesson.id}>
                    <th scope="row">
                      <div className="class-group-lesson-summary">
                        <strong>第 {lesson.sequence} 讲</strong>
                        <span>{lesson.title}</span>
                        <small>{lesson.revision > 0 ? `材料已确认 · 修订 ${lesson.revision}` : lessonMaterialHasContent(lesson.material) ? "材料草稿待确认" : "尚未填写材料"}</small>
                        <details className="class-group-lesson-details">
                          <summary>材料与讲次设置</summary>
                          <div>
                            <Button variant="ghost" uiSize="sm" onClick={() => openLesson(group, lesson)}>编辑材料</Button>
                            <Button variant="secondary" uiSize="sm" disabled={saving || !lesson.hasUnconfirmedChanges || !lessonMaterialHasContent(lesson.material)} onClick={() => void confirmLesson(lesson)}>确认材料</Button>
                            {lesson.sessionLinks.length === 0 && lesson.revision === 0 && !lessonMaterialHasContent(lesson.material) && (
                              <Button variant="danger" uiSize="sm" disabled={saving} onClick={() => setDeletingLesson(lesson)}>删除空讲次</Button>
                            )}
                          </div>
                        </details>
                      </div>
                    </th>
                    {group.memberships.map((membership) => {
                      const link = lesson.sessionLinks.find((item) => linkClassId(item) === membership.classId);
                      return <td key={membership.classId}>{link ? (
                        <div className="class-group-session-cell is-linked">
                          <strong>{link.session.code}</strong>
                          <span>{link.session.date}</span>
                          <Button variant="ghost" uiSize="sm" disabled={saving} aria-label={`解除第 ${lesson.sequence} 讲与 ${classLabel(membership.class)} ${link.session.code} 的关联`} onClick={() => void unlink(lesson.id, link.sessionId)}>解除</Button>
                        </div>
                      ) : (
                        <div className="class-group-session-cell is-missing">
                          <span>缺少真实课次</span>
                          <Button variant="secondary" uiSize="sm" onClick={() => openMatrixLink(group, lesson, membership.classId)}>关联已有</Button>
                        </div>
                      )}</td>;
                    })}
                  </tr>
                ))}</tbody>
              </table>
            </div>

            <section className="class-group-independent">
              <header><div><strong>组内未关联的真实课次</strong><p>这些课次目前独立存在，可能是补课，也可能只是还没有放进共同进度。</p></div><span>{unlinkedSessions.length}</span></header>
              {unlinkedSessions.length === 0 ? <p className="class-group-independent__empty">当前没有待关联课次。</p> : (
                <div className="class-group-independent__list">{unlinkedSessions.map((session) => (
                  <div className="class-group-independent__item" key={session.id}>
                    <div><strong>{classLabel(session.class)}</strong><span>{session.date} · {session.code}</span></div>
                    <Button variant="secondary" uiSize="sm" disabled={group.lessons.length === 0} onClick={() => openIndependentLink(group, session)}>{group.lessons.length === 0 ? "先建立讲次" : "关联到共同讲次"}</Button>
                  </div>
                ))}</div>
              )}
            </section>

            <details className="class-group-secondary-panel">
              <summary>组设置</summary>
              <div><p>更换进度基准班或成员只影响后续建议；已经形成的课次关联仍保留。</p><Button variant="secondary" uiSize="sm" onClick={() => openGroup(group)}>编辑成员与进度基准班</Button>{group.lessons.length === 0 && <Button variant="danger" uiSize="sm" disabled={saving} onClick={() => setDeletingGroup(group)}>删除空班级组</Button>}</div>
            </details>

            {allLinks.length > 0 && <details className="class-group-secondary-panel">
              <summary>关联记录与技术信息{historicalLinkCount > 0 ? ` · ${historicalLinkCount} 条历史成员关联` : ""}</summary>
              <div className="class-group-technical-list">{allLinks.map(({ lesson, link }) => (
                <div key={link.id}>
                  <span>第 {lesson.sequence} 讲 · {classLabel(link.session.class)} · {link.session.code}</span>
                  <small>{syncLabels[link.syncStatus] ?? link.syncStatus} · {link.comparable ? "允许比较" : "不比较"}{link.differenceSummary ? ` · ${link.differenceSummary}` : ""}{!currentMemberIds.has(linkClassId(link)) ? " · 历史成员" : ""}</small>
                </div>
              ))}</div>
            </details>}
          </article>;
        })}</div>
      )}
    </Section>

    <Dialog open={groupDialog} title={editingGroup ? "编辑班级组" : "新建班级组"} onClose={() => { if (!saving) setGroupDialog(false); }}>
      <form className="dialog-form" onSubmit={saveGroup}>
        {error && <StatusBanner tone="danger">{error}</StatusBanner>}
        <label>组名<Input required value={groupName} onChange={(event) => setGroupName(event.target.value)} /></label>
        <fieldset className="class-group-checkboxes"><legend>选择班级</legend>{classes.map((klass) => {
          const unavailable = assignedClassIds.has(klass.id) && !editingGroup?.memberships.some((item) => item.classId === klass.id);
          return <label key={klass.id}><input type="checkbox" disabled={unavailable} checked={groupClassIds.includes(klass.id)} onChange={(event) => {
            setGroupClassIds((current) => event.target.checked ? [...current, klass.id] : current.filter((id) => id !== klass.id));
            if (!event.target.checked && leadClassId === klass.id) setLeadClassId("");
          }} />{classLabel(klass)}{unavailable ? "（已在其他组）" : ""}</label>;
        })}</fieldset>
        <label>进度基准班<Select required value={leadClassId} onChange={(event) => setLeadClassId(event.target.value)}><option value="">请选择用于形成默认建议的班级</option>{classes.filter((klass) => groupClassIds.includes(klass.id)).map((klass) => <option key={klass.id} value={klass.id}>{classLabel(klass)}</option>)}</Select></label>
        <p className="dialog-form__hint">进度基准班只用于形成默认建议；每次新建真实课次时，教师仍可选择建议、独立课次或指定讲次。</p>
        <div className="dialog-form__actions"><Button variant="secondary" onClick={() => setGroupDialog(false)}>取消</Button><Button type="submit" disabled={saving || groupClassIds.length === 0 || !leadClassId}>{saving ? "保存中…" : "保存组设置"}</Button></div>
      </form>
    </Dialog>

    <Dialog open={lessonDialog} title={editingLesson ? `编辑第 ${editingLesson.sequence} 讲` : "建立下一讲"} onClose={() => { if (!saving) setLessonDialog(false); }}>
      <form className="dialog-form" onSubmit={saveLesson}>
        {error && <StatusBanner tone="danger">{error}</StatusBanner>}
        <div className="dialog-form__row"><label>讲次<Input type="number" min={1} readOnly={!editingLesson} value={lessonSequence} onChange={(event) => setLessonSequence(Number(event.target.value))} /></label><label>标题<Input required value={lessonTitle} onChange={(event) => setLessonTitle(event.target.value)} /></label></div>
        <details className="class-group-material-editor" open={Boolean(editingLesson && lessonMaterialHasContent(editingLesson.material))}>
          <summary>课程公共材料（可稍后填写）</summary>
          <div><label>班级公共反馈或课程材料<Textarea rows={7} value={groupFeedbackRaw} onChange={(event) => setGroupFeedbackRaw(event.target.value)} /></label><label>统一测评说明<Textarea rows={5} value={assessmentBriefRaw} onChange={(event) => setAssessmentBriefRaw(event.target.value)} /></label></div>
        </details>
        <p className="dialog-form__hint">建立讲次不会合并各班数据。公共材料只有确认后，反馈任务才会复用。</p>
        <div className="dialog-form__actions"><Button variant="secondary" onClick={() => setLessonDialog(false)}>取消</Button><Button type="submit" disabled={saving}>{saving ? "保存中…" : editingLesson ? "保存草稿" : "建立讲次"}</Button></div>
      </form>
    </Dialog>

    <Dialog open={Boolean(linkTarget)} title={linkTarget?.kind === "matrix-cell" ? `关联 ${classLabel(linkTarget.group.memberships.find((item) => item.classId === linkTarget.classId)?.class ?? null)} 的真实课次` : "选择对应的共同讲次"} onClose={() => { if (!saving) setLinkTarget(null); }}>
      <form className="dialog-form" onSubmit={saveLink}>
        {error && <StatusBanner tone="danger">{error}</StatusBanner>}
        {linkTarget?.kind === "matrix-cell" ? <>
          <p className="dialog-form__hint">{linkTarget.group.name} · 第 {linkTarget.lesson.sequence} 讲</p>
          {linkableSessions.length === 0 ? <EmptyState title="这个班没有可关联课次" description="可先在下方课次列表新建一条独立课次，再回到这里关联。" /> : (
            <label>真实课次<Select required value={linkSessionId} onChange={(event) => setLinkSessionId(event.target.value)}><option value="">请选择</option>{linkableSessions.map((session) => <option value={session.id} key={session.id}>{session.date} · {session.code} · 第 {session.semesterNumber} 次</option>)}</Select></label>
          )}
        </> : linkTarget?.kind === "independent-session" ? <>
          <p className="dialog-form__hint">{classLabel(linkTarget.session.class)} · {linkTarget.session.date} · {linkTarget.session.code}</p>
          {linkableLessons.length === 0 ? <EmptyState title="这个班没有可关联的空缺讲次" description="每个班在同一共同讲次中只能有一条真实课次；这条课可继续保持独立。" /> : <label>共同讲次<Select required value={linkLessonId} onChange={(event) => setLinkLessonId(event.target.value)}><option value="">请选择</option>{linkableLessons.map((lesson) => <option value={lesson.id} key={lesson.id}>第 {lesson.sequence} 讲 · {lesson.title}</option>)}</Select></label>}
        </> : null}
        <p className="dialog-form__hint">默认按正常跟课关联。同步差异和比较标记保留在“关联记录与技术信息”中，不影响日常排课。</p>
        <div className="dialog-form__actions"><Button variant="secondary" onClick={() => setLinkTarget(null)}>取消</Button><Button type="submit" disabled={saving || !linkSessionId || !linkLessonId}>{saving ? "关联中…" : "确认关联"}</Button></div>
      </form>
    </Dialog>

    <ConfirmDialog
      open={Boolean(deletingLesson)}
      title="删除空讲次"
      description={<>将删除“第 {deletingLesson?.sequence} 讲 · {deletingLesson?.title}”。它没有材料、确认修订或真实课次关联。</>}
      confirmLabel="删除空讲次"
      danger
      busy={saving}
      onClose={() => { if (!saving) setDeletingLesson(null); }}
      onConfirm={() => void deleteLesson()}
    />
    <ConfirmDialog
      open={Boolean(deletingGroup)}
      title="删除空班级组"
      description={<>将删除“{deletingGroup?.name}”。班级和真实课次都会保留，只解除当前组设置。</>}
      confirmLabel="删除空班级组"
      danger
      busy={saving}
      onClose={() => { if (!saving) setDeletingGroup(null); }}
      onConfirm={() => void deleteGroup()}
    />
  </>;
}
