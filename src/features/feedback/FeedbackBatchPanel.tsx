"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, FormField, Select, StatusBanner, Textarea } from "@/components/ui";
import { requestJson } from "@/lib/api-client";

interface SemesterSummary { id: string; name: string }
interface SemesterClass { id: string; code: string; name: string }
interface SemesterSession { id: string; code: string; date: string; classId: string | null }
interface SemesterDetail { id: string; classes: SemesterClass[]; sessions: SemesterSession[] }
interface StudentOption { id: string; name: string; studentId: string; classId: string }
interface ClassGroup { id: string; name: string; lessons: Array<{ id: string; title: string; revisions: Array<{ id: string; revision: number }> }> }
interface BatchPlan { id: string; batchOrder: number | null; status: string; class: SemesterClass; progress: { total: number; generated: number; approved: number; exported: number; failed: number } }
interface Batch {
  id: string;
  semesterId: string;
  type: "event_micro" | "stage_trend";
  outputRequirement: string;
  status: string;
  currentPlanId: string | null;
  plans: BatchPlan[];
  progress: { total: number; generated: number; approved: number; exported: number; failed: number; completedClasses: number; totalClasses: number };
}

const activeStatuses = new Set(["queued", "running", "pause_requested"]);

export function FeedbackBatchPanel({ initialSemesterId }: { initialSemesterId?: string }) {
  const [semesters, setSemesters] = useState<SemesterSummary[]>([]);
  const [semesterId, setSemesterId] = useState(initialSemesterId ?? "");
  const [detail, setDetail] = useState<SemesterDetail | null>(null);
  const [groups, setGroups] = useState<ClassGroup[]>([]);
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [activeBatchId, setActiveBatchId] = useState("");
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [sessionByClass, setSessionByClass] = useState<Record<string, string>>({});
  const [rangeStartByClass, setRangeStartByClass] = useState<Record<string, string>>({});
  const [studentIdsByClass, setStudentIdsByClass] = useState<Record<string, string[]>>({});
  const [assessmentByClass, setAssessmentByClass] = useState<Record<string, Record<string, unknown>>>({});
  const [assessmentConfirmedByClass, setAssessmentConfirmedByClass] = useState<Record<string, boolean>>({});
  const [type, setType] = useState<"event_micro" | "stage_trend">("event_micro");
  const [outputRequirement, setOutputRequirement] = useState("为每名入选学生生成一条可复核的家长反馈");
  const [sharedLessonRevisionId, setSharedLessonRevisionId] = useState("");
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [repeatExport, setRepeatExport] = useState<"complete" | "approved_only" | null>(null);

  const activeBatch = batches.find((batch) => batch.id === activeBatchId) ?? batches[0] ?? null;
  const revisionOptions = groups.flatMap((group) => group.lessons.flatMap((lesson) => lesson.revisions.map((revision) => ({ id: revision.id, label: `${group.name} · ${lesson.title} · 修订 ${revision.revision}` }))));

  const loadBatches = useCallback(async (targetSemesterId: string) => {
    if (!targetSemesterId) return setBatches([]);
    const response = await requestJson<{ batches: Batch[] }>(`/api/report/feedback-plan-batches?semesterId=${encodeURIComponent(targetSemesterId)}`);
    setBatches(response.batches);
    setActiveBatchId((current) => response.batches.some((batch) => batch.id === current) ? current : response.batches[0]?.id ?? "");
  }, []);

  useEffect(() => {
    void requestJson<SemesterSummary[]>("/api/semesters").then((items) => {
      setSemesters(items);
      setSemesterId((current) => current || items[0]?.id || "");
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "加载学期失败"));
  }, []);

  useEffect(() => {
    if (initialSemesterId) setSemesterId(initialSemesterId);
  }, [initialSemesterId]);

  useEffect(() => {
    if (!semesterId) return;
    setError("");
    void Promise.all([
      requestJson<SemesterDetail>(`/api/semesters/${encodeURIComponent(semesterId)}`),
      requestJson<{ groups: ClassGroup[] }>(`/api/semesters/${encodeURIComponent(semesterId)}/class-groups`),
      requestJson<StudentOption[]>(`/api/students?${new URLSearchParams({ semesterId, scope: "active" })}`),
      loadBatches(semesterId),
    ]).then(([semester, groupResponse, studentResponse]) => {
      setDetail(semester);
      setGroups(groupResponse.groups);
      setStudents(studentResponse);
      setSelectedClasses([]);
      setSessionByClass({});
      setRangeStartByClass({});
      setStudentIdsByClass({});
      setAssessmentByClass({});
      setAssessmentConfirmedByClass({});
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "加载批次准备信息失败"));
  }, [semesterId, loadBatches]);

  useEffect(() => {
    if (!activeBatch || !activeStatuses.has(activeBatch.status)) return;
    const timer = window.setInterval(() => void loadBatches(activeBatch.semesterId).catch(() => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [activeBatch, loadBatches]);

  const sessionsByClass = useMemo(() => new Map((detail?.classes ?? []).map((item) => [item.id, (detail?.sessions ?? []).filter((session) => session.classId === item.id).sort((a, b) => b.date.localeCompare(a.date))])), [detail]);

  function toggleClass(classId: string) {
    setSelectedClasses((current) => current.includes(classId) ? current.filter((id) => id !== classId) : [...current, classId]);
    const sessions = sessionsByClass.get(classId) ?? [];
    if (sessions[0]) {
      setSessionByClass((current) => ({ ...current, [classId]: current[classId] ?? sessions[0]!.id }));
      setRangeStartByClass((current) => ({ ...current, [classId]: current[classId] ?? sessions.at(-1)!.id }));
    }
    setStudentIdsByClass((current) => ({ ...current, [classId]: current[classId] ?? students.filter((student) => student.classId === classId).map((student) => student.id) }));
  }

  function toggleStudent(classId: string, studentId: string) {
    setStudentIdsByClass((current) => {
      const selected = current[classId] ?? [];
      return { ...current, [classId]: selected.includes(studentId) ? selected.filter((id) => id !== studentId) : [...selected, studentId] };
    });
  }

  function selectTargetSession(classId: string, sessionId: string) {
    setSessionByClass((current) => ({ ...current, [classId]: sessionId }));
    setAssessmentByClass((current) => ({ ...current, [classId]: {} }));
    setAssessmentConfirmedByClass((current) => ({ ...current, [classId]: false }));
  }

  async function importAssessmentPdfs(classId: string, files: FileList | null) {
    const sessionId = sessionByClass[classId];
    const session = (sessionsByClass.get(classId) ?? []).find((item) => item.id === sessionId);
    if (!session || !files?.length) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const results = await Promise.all([...files].map(async (file) => {
        const formData = new FormData();
        formData.set("sessionCode", session.code);
        formData.set("file", file);
        return requestJson<{ matchedStudentId: string; matchedStudentName: string; evidence: unknown }>("/api/feedback/assessment-pdf", { method: "POST", body: formData });
      }));
      const classStudentIds = new Set(students.filter((student) => student.classId === classId).map((student) => student.id));
      const unmatched = results.filter((result) => !result.matchedStudentId || !classStudentIds.has(result.matchedStudentId));
      if (unmatched.length) throw new Error(`有 ${unmatched.length} 份 PDF 未能匹配该班学生，请核对报告姓名、学号或文件名`);
      setAssessmentByClass((current) => ({ ...current, [classId]: { ...(current[classId] ?? {}), ...Object.fromEntries(results.map((result) => [result.matchedStudentId, result.evidence])) } }));
      setAssessmentConfirmedByClass((current) => ({ ...current, [classId]: false }));
      setNotice(`已解析 ${results.length} 份 PDF；请在对应班级确认后再创建批次。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "解析 PDF 失败"); }
    finally { setBusy(false); }
  }

  async function createBatch() {
    if (selectedClasses.length < 2) return setError("至少选择两个班级");
    if (selectedClasses.some((classId) => !sessionByClass[classId])) return setError("每个班都要确认课次");
    if (selectedClasses.some((classId) => !(studentIdsByClass[classId]?.length))) return setError("每个班至少确认一名学生");
    if (selectedClasses.some((classId) => Object.keys(assessmentByClass[classId] ?? {}).length > 0 && !assessmentConfirmedByClass[classId])) return setError("有班级的 PDF 证据尚未由教师确认");
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await requestJson<{ batch: Batch }>("/api/report/feedback-plan-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestKey,
          semesterId,
          type,
          outputRequirement,
          sharedLessonRevisionId: sharedLessonRevisionId || undefined,
          sharedMaterialConfirmed: sharedLessonRevisionId ? true : undefined,
          plans: selectedClasses.map((classId) => ({
            classId,
            ...(type === "event_micro"
              ? { sessionId: sessionByClass[classId] }
              : { rangeStartSessionId: rangeStartByClass[classId], rangeEndSessionId: sessionByClass[classId] }),
            studentIds: studentIdsByClass[classId],
            assessmentEvidence: Object.fromEntries(Object.entries(assessmentByClass[classId] ?? {}).filter(([studentId]) => (studentIdsByClass[classId] ?? []).includes(studentId))),
          })),
        }),
      });
      await loadBatches(semesterId);
      setActiveBatchId(response.batch.id);
      setRequestKey(crypto.randomUUID());
      setNotice("批次及各班独立反馈计划已原子创建。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建反馈批次失败"); }
    finally { setBusy(false); }
  }

  async function runAction(action: "start" | "pause" | "continue" | "retry" | "archive") {
    if (!activeBatch) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await requestJson(`/api/report/feedback-plan-batches/${activeBatch.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      await loadBatches(activeBatch.semesterId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "批次操作失败"); }
    finally { setBusy(false); }
  }

  async function exportBatch(mode: "complete" | "approved_only", allowRepeat = false) {
    if (!activeBatch) return;
    setBusy(true); setError(""); setRepeatExport(null);
    try {
      const response = await fetch(`/api/report/feedback-plan-batches/${activeBatch.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "export", mode, allowRepeat }) });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({})) as { error?: string; code?: string };
        if (failure.code === "repeat_export") setRepeatExport(mode);
        throw new Error(failure.error ?? "合并导出失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `feedback-batch_${activeBatch.id}.xlsx`; anchor.click(); URL.revokeObjectURL(url);
      setNotice(mode === "complete" ? "完整批次已重新导出。" : "新增已批准条目已合并导出。");
      await loadBatches(activeBatch.semesterId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "合并导出失败"); }
    finally { setBusy(false); }
  }

  return <details className="feedback-batch-panel" open={Boolean(activeBatch)}>
    <summary><strong>多班反馈批次（1.2 Beta）</strong><span>{activeBatch ? `${activeBatch.progress.completedClasses}/${activeBatch.progress.totalClasses} 班 · ${activeBatch.status}` : "按班串行、逐班复核"}</span></summary>
    <div className="feedback-batch-panel__body">
      {error && <StatusBanner tone="danger">{error}</StatusBanner>}
      {notice && <StatusBanner tone="success">{notice}</StatusBanner>}
      {repeatExport && <StatusBanner tone="warning"><span>相同清单已经导出过。</span><Button uiSize="sm" variant="secondary" onClick={() => void exportBatch(repeatExport, true)} disabled={busy}>确认重复导出</Button></StatusBanner>}
      <div className="feedback-batch-panel__create">
        <FormField label="学期"><Select value={semesterId} onChange={(event) => setSemesterId(event.target.value)}>{semesters.map((semester) => <option key={semester.id} value={semester.id}>{semester.name}</option>)}</Select></FormField>
        <FormField label="反馈类型"><Select value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="event_micro">事件微反馈</option><option value="stage_trend">阶段趋势</option></Select></FormField>
        <FormField label="共同课修订（可选）"><Select value={sharedLessonRevisionId} onChange={(event) => setSharedLessonRevisionId(event.target.value)}><option value="">不使用</option>{revisionOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</Select></FormField>
        <FormField label="输出要求" className="feedback-batch-panel__requirement"><Textarea value={outputRequirement} onChange={(event) => setOutputRequirement(event.target.value)} /></FormField>
        <div className="feedback-batch-panel__classes">
          {(detail?.classes ?? []).map((classRecord) => {
            const selected = selectedClasses.includes(classRecord.id);
            const sessions = sessionsByClass.get(classRecord.id) ?? [];
            return <article key={classRecord.id}>
              <label><input type="checkbox" checked={selected} onChange={() => toggleClass(classRecord.id)} /> <strong>{classRecord.code}</strong> {classRecord.name}</label>
              {selected && <div>
                {type === "stage_trend" && <Select aria-label={`${classRecord.name}起始课次`} value={rangeStartByClass[classRecord.id] ?? ""} onChange={(event) => setRangeStartByClass((current) => ({ ...current, [classRecord.id]: event.target.value }))}>{sessions.map((session) => <option key={session.id} value={session.id}>起：{session.date} · {session.code}</option>)}</Select>}
                <Select aria-label={`${classRecord.name}${type === "stage_trend" ? "截止" : "目标"}课次`} value={sessionByClass[classRecord.id] ?? ""} onChange={(event) => selectTargetSession(classRecord.id, event.target.value)}>{sessions.map((session) => <option key={session.id} value={session.id}>{type === "stage_trend" ? "止" : "课次"}：{session.date} · {session.code}</option>)}</Select>
              </div>}
              {selected && <details><summary>学生 {studentIdsByClass[classRecord.id]?.length ?? 0}/{students.filter((student) => student.classId === classRecord.id).length}</summary><div className="feedback-batch-panel__students">{students.filter((student) => student.classId === classRecord.id).map((student) => <label key={student.id}><input type="checkbox" checked={(studentIdsByClass[classRecord.id] ?? []).includes(student.id)} onChange={() => toggleStudent(classRecord.id, student.id)} /> {student.name} <small>{student.studentId}</small></label>)}</div></details>}
              {selected && <div className="feedback-batch-panel__pdf"><label className="ui-button ui-button--secondary ui-button--sm">选择本班 PDF<input type="file" accept=".pdf,application/pdf" multiple hidden disabled={busy || !sessionByClass[classRecord.id]} onChange={(event) => { void importAssessmentPdfs(classRecord.id, event.target.files); event.currentTarget.value = ""; }} /></label><span>{Object.keys(assessmentByClass[classRecord.id] ?? {}).length} 份已匹配</span>{Object.keys(assessmentByClass[classRecord.id] ?? {}).length > 0 && <label><input type="checkbox" checked={assessmentConfirmedByClass[classRecord.id] === true} onChange={(event) => setAssessmentConfirmedByClass((current) => ({ ...current, [classRecord.id]: event.target.checked }))} /> 教师确认本班 PDF</label>}</div>}
            </article>;
          })}
        </div>
        <Button onClick={() => void createBatch()} disabled={busy || selectedClasses.length < 2}>原子创建批次</Button>
      </div>
      {batches.length > 0 && <div className="feedback-batch-panel__manage">
        <Select aria-label="反馈批次" value={activeBatch?.id ?? ""} onChange={(event) => setActiveBatchId(event.target.value)}>{batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.type === "event_micro" ? "事件" : "阶段"} · {batch.plans.length} 班 · {batch.status}</option>)}</Select>
        {activeBatch && <>
          <div className="feedback-batch-panel__progress"><span style={{ width: `${activeBatch.progress.total ? Math.round(activeBatch.progress.generated / activeBatch.progress.total * 100) : 0}%` }} /></div>
          <p>已生成 {activeBatch.progress.generated}/{activeBatch.progress.total}，已批准 {activeBatch.progress.approved}，已进入批次导出 {activeBatch.progress.exported}。</p>
          <div className="feedback-batch-panel__plans">{activeBatch.plans.map((plan) => <a key={plan.id} className={plan.id === activeBatch.currentPlanId ? "is-current" : ""} href={`/feedback?step=export&planId=${encodeURIComponent(plan.id)}`}><strong>{plan.class.code}</strong><span>{plan.class.name} · {plan.status} · {plan.progress.generated}/{plan.progress.total}</span></a>)}</div>
          <div className="feedback-batch-panel__actions">
            {activeBatch.status === "ready" && <Button onClick={() => void runAction("start")} disabled={busy}>开始逐班生成</Button>}
            {["queued", "running"].includes(activeBatch.status) && <Button variant="warning" onClick={() => void runAction("pause")} disabled={busy}>暂停</Button>}
            {["queued", "running"].includes(activeBatch.status) && <Button variant="ghost" onClick={() => void runAction("continue")} disabled={busy}>恢复执行</Button>}
            {["paused", "pause_requested"].includes(activeBatch.status) && <Button onClick={() => void runAction("continue")} disabled={busy}>继续</Button>}
            {activeBatch.status === "failed" && <Button onClick={() => void runAction("retry")} disabled={busy}>重试当前班</Button>}
            <Button variant="secondary" onClick={() => void exportBatch("approved_only")} disabled={busy}>导出新增已批准</Button>
            <Button variant="ghost" onClick={() => void exportBatch("complete")} disabled={busy}>完整批次重导</Button>
            {["ready", "paused", "failed", "completed"].includes(activeBatch.status) && <Button variant="ghost" onClick={() => void runAction("archive")} disabled={busy}>归档</Button>}
          </div>
          <small>点击班级进入现有单班页面复核；编辑和批准只作用于该班。批次不会生成 WCG 草稿包，也不会发送。</small>
        </>}
      </div>}
    </div>
  </details>;
}
