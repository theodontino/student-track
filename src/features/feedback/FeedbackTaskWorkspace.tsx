"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import packageMetadata from "../../../package.json";
import SemesterPicker from "@/components/SemesterPicker";
import { Badge, Button, Input, PageHeader, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import { lessonMaterialHasContent } from "@/lib/feedback-materials";
import type { FeedbackScriptLibraryResponse } from "@/lib/feedback-script-library";
import type { FeedbackIntakeDecision } from "@/services/feedback-intake-service";
import { isBlockingFeedbackIntakeIssue } from "@/lib/feedback-intake-rules";
import FeedbackPlanManager from "./FeedbackPlanManager";
import { TaskPreparationStage } from "./TaskPreparationStage";
import { TaskConfirmationStage } from "./TaskConfirmationStage";
import { FeedbackTaskStudioStage } from "./FeedbackTaskStudioStage";
import type { FeedbackIntakeRunClient } from "./feedback-task-types";
import {
  activeTaskEntry,
  createFeedbackTaskDraft,
  feedbackTaskReducer,
  type FeedbackTaskClassDraft,
  type FeedbackTaskState,
} from "./feedback-task-state";
import { clearFeedbackTaskDraft, readFeedbackTaskDraft, useFeedbackTaskDraftPersistence } from "./useFeedbackTaskDraft";
import { useFeedbackTaskContext } from "./useFeedbackTaskContext";
import styles from "./unified-feedback-workspace.module.css";

function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : "操作失败"; }

function initialState({ planId, batchId }: { planId: string; batchId: string }): FeedbackTaskState {
  return { stage: planId || batchId ? "studio" : "prepare", draft: createFeedbackTaskDraft(), planId, batchId };
}

function taskUrl(patch: { planId?: string; batchId?: string; intakeRunId?: string }) {
  const url = new URL(window.location.href);
  for (const key of ["step", "advanced", "groupMode"]) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(patch)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export default function FeedbackTaskWorkspace({ initialPlanId = "", initialBatchId = "" }: { initialPlanId?: string; initialBatchId?: string }) {
  const context = useFeedbackTaskContext();
  const [state, dispatch] = useReducer(feedbackTaskReducer, { planId: initialPlanId, batchId: initialBatchId }, initialState);
  const [runs, setRuns] = useState<Record<string, FeedbackIntakeRunClient>>({});
  const [decisions, setDecisions] = useState<Record<string, FeedbackIntakeDecision[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [scriptLibrary, setScriptLibrary] = useState<FeedbackScriptLibraryResponse>({ library: null, recommendedLessonNumber: null });
  const [selectedCommonMaterialLesson, setSelectedCommonMaterialLesson] = useState<number | null>(null);
  const restored = useRef(false);
  const initializedStudents = useRef(new Set<string>());
  const initializedMaterialSession = useRef("");
  const entry = activeTaskEntry(state);

  useFeedbackTaskDraftPersistence(state.draft, context.hydrated && state.stage !== "studio");

  useEffect(() => {
    if (!context.hydrated) return;
    const params = new URLSearchParams(window.location.search);
    const planId = params.get("planId") ?? "";
    const batchId = params.get("batchId") ?? "";
    if ((planId || batchId) && (state.stage !== "studio" || state.planId !== planId || state.batchId !== batchId)) {
      dispatch({ type: "task", planId, batchId });
    }
  }, [context.hydrated, state.batchId, state.planId, state.stage]);

  useEffect(() => {
    if (!context.hydrated || restored.current || state.planId || state.batchId) return;
    restored.current = true;
    const saved = readFeedbackTaskDraft();
    if (saved) {
      const current = saved.entries.find((item) => item.sessionCode === context.context.sessionCode)
        ?? saved.entries.find((item) => item.sessionCode === saved.activeSessionCode)
        ?? saved.entries[0];
      dispatch({ type: "restore", draft: { ...saved, mode: "single", groupLessonId: "", entries: current ? [{ ...current, selected: true }] : [], activeSessionCode: current?.sessionCode ?? "" } });
    }
  }, [context.context.sessionCode, context.hydrated, state.batchId, state.planId]);

  const loadRun = useCallback(async (runId: string) => {
    const result = await requestJson<{ run: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(runId)}`);
    setRuns((current) => ({ ...current, [runId]: result.run }));
    const stored = Array.isArray(result.run.appliedSummary.decisions) ? result.run.appliedSummary.decisions : [];
    setDecisions((current) => ({ ...current, [runId]: stored }));
    return result.run;
  }, []);

  useEffect(() => {
    for (const item of state.draft.entries) if (item.runId && !runs[item.runId]) void loadRun(item.runId).catch(() => undefined);
  }, [loadRun, runs, state.draft.entries]);

  useEffect(() => {
    if (!context.data?.session || state.stage === "studio") return;
    const session = context.data.session;
    const existing = state.draft.entries.find((item) => item.sessionCode === session.code);
    if (existing) {
      if (state.draft.mode !== "single" || state.draft.entries.length !== 1 || state.draft.activeSessionCode !== session.code) {
        dispatch({ type: "draft", patch: { mode: "single", groupLessonId: "", entries: [{ ...existing, selected: true }], activeSessionCode: session.code } });
      }
      if (!initializedStudents.current.has(session.code) && existing.studentIds.length === 0 && context.data.students.length) {
        initializedStudents.current.add(session.code);
        dispatch({ type: "entry", sessionCode: session.code, patch: { studentIds: context.data.students.map((student) => student.id) } });
      }
      return;
    }
    const current: FeedbackTaskClassDraft = {
      classId: session.classId,
      classCode: context.context.className,
      className: context.context.className || context.data.className,
      sessionCode: session.code,
      runId: "",
      studentIds: context.data.students.map((student) => student.id),
      selected: true,
    };
    dispatch({ type: "entries", entries: [current] });
    dispatch({ type: "draft", patch: { activeSessionCode: session.code } });
  }, [context.context.className, context.data, state.draft.activeSessionCode, state.draft.entries, state.draft.mode, state.stage]);

  useEffect(() => {
    if (!context.data || state.stage === "studio") return;
    if (initializedMaterialSession.current === context.data.session?.code) return;
    initializedMaterialSession.current = context.data.session?.code ?? "";
    if (state.draft.materialSelection.mode !== "none") return;
    const revision = context.data.groupProgress?.status === "linked" ? context.data.groupProgress.lesson?.revisions?.[0] : null;
    if (revision) dispatch({ type: "draft", patch: { materialSelection: { mode: "linked_revision", revisionId: revision.id } } });
    else if (context.data.sessionCommonMaterial?.confirmedAt) dispatch({ type: "draft", patch: { materialSelection: { mode: "session_snapshot" } } });
  }, [context.data, state.draft.materialSelection.mode, state.stage]);

  useEffect(() => {
    if (!context.context.semesterId || !context.context.sessionCode || state.stage === "studio") {
      setScriptLibrary({ library: null, recommendedLessonNumber: null });
      setSelectedCommonMaterialLesson(null);
      return;
    }
    let cancelled = false;
    const query = new URLSearchParams({ semesterId: context.context.semesterId, sessionCode: context.context.sessionCode });
    requestJson<FeedbackScriptLibraryResponse>(`/api/feedback/script-library?${query}`)
      .then((result) => {
        if (cancelled) return;
        setScriptLibrary(result);
        const sourceLesson = context.data?.groupProgress?.lesson?.draftMaterial.semesterScriptSource?.lessonNumber
          ?? context.data?.sessionCommonMaterial?.material.semesterScriptSource?.lessonNumber
          ?? result.recommendedLessonNumber;
        setSelectedCommonMaterialLesson(sourceLesson ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setScriptLibrary({ library: null, recommendedLessonNumber: null });
          setSelectedCommonMaterialLesson(null);
        }
      });
    return () => { cancelled = true; };
  }, [context.context.semesterId, context.context.sessionCode, context.data?.groupProgress?.lesson?.id, context.data?.session?.id, state.stage]);

  async function acceptRun(result: { run: FeedbackIntakeRunClient }) {
    setRuns((current) => ({ ...current, [result.run.id]: result.run }));
    setDecisions((current) => ({ ...current, [result.run.id]: Array.isArray(result.run.appliedSummary.decisions) ? result.run.appliedSummary.decisions : [] }));
    dispatch({ type: "entry", sessionCode: result.run.sessionCode, patch: { runId: result.run.id } });
    taskUrl({ intakeRunId: result.run.id });
    setNotice(result.run.issues.some(isBlockingFeedbackIntakeIssue) ? "材料已整理；进入下一阶段只处理真正阻断归属的问题。" : "材料已整理，等待教师确认。 ");
  }

  async function uploadFiles(files: File[]) {
    if (!entry || !files.length) return;
    setBusy(true); setError(""); setNotice("正在整理材料…");
    try {
      const form = new FormData();
      form.set("sessionCode", entry.sessionCode);
      if (entry.runId && !runs[entry.runId]?.planId) form.set("runId", entry.runId);
      form.set("displayNames", JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)));
      for (const file of files) form.append("files", file);
      const response = await fetch("/api/feedback/intake/upload", { method: "POST", body: form });
      const payload = await response.json().catch(() => null) as ({ run?: FeedbackIntakeRunClient; error?: string }) | null;
      if (!response.ok || !payload?.run) throw new Error(payload?.error || "导入材料失败");
      await acceptRun({ run: payload.run });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function scanInbox() {
    if (!entry) return;
    setBusy(true); setError(""); setNotice("正在扫描反馈收件箱…");
    try {
      const result = await requestJson<{ run: FeedbackIntakeRunClient }>("/api/feedback/intake/scan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionCode: entry.sessionCode, ...(entry.runId && !runs[entry.runId]?.planId ? { runId: entry.runId } : {}) }),
      });
      await acceptRun(result);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function saveCommonMaterial() {
    if (!context.data?.session || !selectedCommonMaterialLesson) return;
    setBusy(true); setError("");
    try {
      if (context.data.groupProgress?.status === "linked" && context.data.groupProgress.lesson) {
        await requestJson(`/api/group-lessons/${encodeURIComponent(context.data.groupProgress.lesson.id)}/common-material`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonNumber: selectedCommonMaterialLesson }),
        });
        setNotice(`已把学期公共材料第 ${selectedCommonMaterialLesson} 课保存为共同课草稿；尚未共享给其他班。`);
      } else {
        await requestJson(`/api/sessions/${encodeURIComponent(context.data.session.id)}/common-material`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonNumber: selectedCommonMaterialLesson }),
        });
        dispatch({ type: "draft", patch: { materialSelection: { mode: "session_snapshot" } } });
        setNotice(`已把学期公共材料第 ${selectedCommonMaterialLesson} 课保存为本课公共材料。`);
      }
      context.refresh();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function confirmCommonMaterial() {
    const lesson = context.data?.groupProgress?.lesson;
    if (!lesson || !selectedCommonMaterialLesson) return;
    setBusy(true); setError("");
    try {
      await requestJson(`/api/group-lessons/${encodeURIComponent(lesson.id)}/common-material`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonNumber: selectedCommonMaterialLesson }),
      });
      const result = await requestJson<{ revision: { id: string; revision: number } }>(`/api/group-lessons/${encodeURIComponent(lesson.id)}/confirm`, { method: "POST" });
      dispatch({ type: "draft", patch: { materialSelection: { mode: "linked_revision", revisionId: result.revision.id } } });
      setNotice(`共同课第 ${lesson.sequence} 讲材料已确认并共享（修订 ${result.revision.revision}）。`);
      context.refresh();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  function updateDecision(decision: FeedbackIntakeDecision) {
    if (!entry?.runId) return;
    setDecisions((current) => ({ ...current, [entry.runId]: [...(current[entry.runId] ?? []).filter((item) => item.issueId !== decision.issueId), decision] }));
  }

  async function confirmFacts() {
    if (!entry?.runId) return;
    setBusy(true); setError("");
    try {
      const result = await requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(entry.runId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", decisions: decisions[entry.runId] ?? [] }),
      });
      setRuns((current) => ({ ...current, [entry.runId]: result.result }));
      setNotice("本班材料与事实已确认；计划尚未创建。请继续确认班级范围。");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function confirmScope() {
    if (!entry?.runId) return;
    setBusy(true); setError("");
    try {
      const result = await requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(entry.runId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm_scope", scope: { classId: entry.classId, sessionCode: entry.sessionCode, studentIds: entry.studentIds } }),
      });
      setRuns((current) => ({ ...current, [entry.runId]: result.result }));
      setNotice("班级、课次和反馈对象已保存。确认其他班后再统一创建任务。 ");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function clearScopes() {
    setBusy(true); setError("");
    try {
      const targets = entry?.runId ? [entry] : [];
      const results = await Promise.all(targets.map((item) => requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(item.runId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear_scope" }) })));
      setRuns((current) => Object.assign({}, current, ...results.map((result) => ({ [result.result.id]: result.result }))));
      dispatch({ type: "stage", stage: "prepare" });
      setNotice("已清除本轮班级范围；已确认课堂事实仍保留。 ");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function createTask() {
    const selectedEntries = entry?.runId ? [entry] : [];
    setBusy(true); setError(""); setNotice("任务正在落账，随后启动生成…");
    try {
      const result = await requestJson<{ taskType: "plan" | "batch"; planId: string | null; firstPlanId?: string | null; batchId: string | null; generationStatus: string; warning?: string }>("/api/feedback/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "single",
          runIds: selectedEntries.map((item) => item.runId),
          generationMode: state.draft.generationMode,
          outputRequirement: state.draft.outputRequirement,
          materialSelection: state.draft.materialSelection,
          preferences: state.draft.preferences,
        }),
      });
      const planId = result.planId ?? result.firstPlanId ?? "";
      dispatch({ type: "task", planId, batchId: result.batchId ?? "" });
      taskUrl({ planId, batchId: result.batchId ?? "" });
      clearFeedbackTaskDraft();
      setNotice(result.generationStatus === "start_failed" ? `任务已建立。${result.warning ?? "生成尚未启动，可在工作室重试。"}` : "任务已建立并开始生成。 ");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  function changeStudioPlan(next: { id: string; className: string; sessionCode: string }) {
    dispatch({ type: "task", planId: next.id, batchId: state.batchId });
    taskUrl({ planId: next.id, batchId: state.batchId });
    context.switchSession(next);
  }

  async function endAndStartNew() {
    const kind = state.batchId ? "feedback-plan-batches" : "feedback-plans";
    const id = state.batchId || state.planId;
    if (!id || !window.confirm("结束并归档当前任务，再建立一轮新任务吗？课堂事实和历史正文会保留。")) return;
    setBusy(true); setError("");
    try {
      if (state.batchId) {
        const current = await requestJson<{ batch: { status: string } }>(`/api/report/feedback-plan-batches/${encodeURIComponent(id)}`);
        if (["queued", "running", "pause_requested"].includes(current.batch.status)) {
          await requestJson(`/api/report/feedback-plan-batches/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pause" }) });
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            const polled = await requestJson<{ batch: { status: string } }>(`/api/report/feedback-plan-batches/${encodeURIComponent(id)}`);
            if (!["queued", "running", "pause_requested"].includes(polled.batch.status)) break;
            if (attempt === 39) throw new Error("班级组仍在安全暂停，请稍后重试");
          }
        }
      } else {
        const current = await requestJson<{ plan: { status: string } }>(`/api/report/feedback-plans/${encodeURIComponent(id)}`);
        if (["queued", "generating", "pause_requested"].includes(current.plan.status)) {
          await requestJson(`/api/report/feedback-plans/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "pause_generation" }) });
          for (let attempt = 0; attempt < 40; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            const polled = await requestJson<{ plan: { status: string } }>(`/api/report/feedback-plans/${encodeURIComponent(id)}`);
            if (!["queued", "generating", "pause_requested"].includes(polled.plan.status)) break;
            if (attempt === 39) throw new Error("计划仍在安全暂停，请稍后重试");
          }
        }
      }
      await requestJson(`/api/report/${kind}/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive" }) });
      await clearScopes();
      dispatch({ type: "task", planId: "", batchId: "" });
      dispatch({ type: "stage", stage: "prepare" });
      taskUrl({ planId: "", batchId: "" });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  const currentRun = entry?.runId ? runs[entry.runId] ?? null : null;
  const material = context.data?.groupProgress?.lesson?.confirmedMaterial ?? context.data?.sessionCommonMaterial?.material;
  const availableMaterial = context.data?.groupProgress?.status === "linked" && context.data.groupProgress.lesson?.revisions?.[0]
    ? { mode: "linked_revision" as const, revisionId: context.data.groupProgress.lesson.revisions[0].id }
    : context.data?.sessionCommonMaterial?.confirmedAt ? { mode: "session_snapshot" as const } : null;
  const materialLabel = context.data?.groupProgress?.lesson
    ? context.data.groupProgress.lesson.revisions[0]
      ? `班级组第 ${context.data.groupProgress.lesson.sequence} 讲 · 已确认修订 ${context.data.groupProgress.lesson.revision}`
      : lessonMaterialHasContent(context.data.groupProgress.lesson.draftMaterial)
        ? `班级组第 ${context.data.groupProgress.lesson.sequence} 讲 · 公共材料草稿待确认`
        : `班级组第 ${context.data.groupProgress.lesson.sequence} 讲 · 尚未选择公共材料`
    : context.data?.sessionCommonMaterial?.confirmedAt
      ? "当前独立课次已确认公共材料"
      : "当前独立课次尚未保存公共材料";
  const commonMaterialOptions = (scriptLibrary.library?.entries ?? []).map((item) => ({
    lessonNumber: item.lessonNumber,
    label: `第 ${item.lessonNumber} 课${item.topic ? ` · ${item.topic}` : ""}`,
    preview: item.material?.groupFeedbackRaw ?? item.groupFeedback,
  }));
  const selectedMaterialPreview = commonMaterialOptions.find((item) => item.lessonNumber === selectedCommonMaterialLesson)?.preview;
  const groupProgress = context.data?.groupProgress;
  const commonMaterialAction = groupProgress?.status === "linked"
    ? (groupProgress.isLeadClass ? "group" as const : "unavailable" as const)
    : groupProgress?.status === "lead_required" ? "unavailable" as const : "session" as const;
  const commonMaterialHelp = groupProgress?.status === "linked"
    ? groupProgress.isLeadClass
      ? `当前为主班第 ${groupProgress.lesson?.sequence ?? "-"} 讲；先保存草稿，确认后其他班直接继承。`
      : `本班跟随主班第 ${groupProgress.lesson?.sequence ?? "-"} 讲；公共材料由主班确认，本班直接继承。`
    : groupProgress?.status === "lead_required"
      ? "当前班级组尚未指定主班，请先在学期管理中设置主班。"
      : groupProgress?.group
        ? "主班尚未推进到本讲；当前真实课次暂按独立课次保存材料。"
        : "独立课次需要教师明确保存公共材料，不会自动套用。";

  return <main className={styles.page}>
    <PageHeader title="课后任务" description="准备任务，核对并确认，再进入生成与复核。全程只有这一套工作流。" actions={<div className={styles.headerActions}><Badge tone="info">{packageMetadata.version}</Badge><Link className="ui-button ui-button--ghost ui-button--md" href="/feedback/tools">高级工具</Link></div>} />
    <details><summary>当前反馈任务</summary><FeedbackPlanManager semesterId={context.context.semesterId} /></details>
    {(error || context.error) && <StatusBanner tone="danger">{error || context.error}</StatusBanner>}{notice && <StatusBanner tone="info">{notice}</StatusBanner>}
    {state.stage !== "studio" && <section className={styles.taskCard}>
      <div className="feedback-context-section"><SemesterPicker semesterId={context.context.semesterId} onSemesterChange={context.setSemesterId} className={context.context.className} onClassChange={context.setClassName} sessionCode={context.context.sessionCode} onSessionChange={context.setSessionCode} refreshKey={context.refreshKey} /><div className="feedback-new-session"><label htmlFor="task-new-session">新课次日期</label><Input id="task-new-session" type="date" value={context.newSessionDate} onChange={(event) => context.setNewSessionDate(event.target.value)} /><Button variant="secondary" onClick={() => void context.createSession()} disabled={context.creatingSession}>{context.creatingSession ? "新建中…" : "新建课次"}</Button></div></div>
      <nav className={styles.taskRail} aria-label="反馈任务阶段"><button type="button" className={state.stage === "prepare" ? styles.activeRail : ""} onClick={() => dispatch({ type: "stage", stage: "prepare" })}><span>1</span><strong>准备任务</strong><small>统一投料</small></button><button type="button" className={state.stage === "confirm" ? styles.activeRail : ""} disabled={!currentRun} onClick={() => dispatch({ type: "stage", stage: "confirm" })}><span>2</span><strong>核对并确认</strong><small>事实与范围</small></button><button type="button" disabled><span>3</span><strong>生成与复核</strong><small>计划工作室</small></button></nav>
      {entry && state.stage === "prepare" && <TaskPreparationStage draft={state.draft} entry={entry} run={currentRun} students={context.data?.students ?? []} busy={busy} commonMaterialLabel={materialLabel} commonMaterialPreview={selectedMaterialPreview ?? material?.groupFeedbackRaw ?? ""} availableMaterial={availableMaterial} commonMaterialOptions={commonMaterialOptions} selectedCommonMaterialLesson={selectedCommonMaterialLesson} commonMaterialAction={commonMaterialAction} commonMaterialHelp={commonMaterialHelp} onCommonMaterialLesson={setSelectedCommonMaterialLesson} onSaveCommonMaterial={() => void saveCommonMaterial()} onConfirmCommonMaterial={() => void confirmCommonMaterial()} onFiles={(files) => void uploadFiles(files)} onScan={() => void scanInbox()} onEntry={(patch) => dispatch({ type: "entry", sessionCode: entry.sessionCode, patch })} onDraft={(patch) => dispatch({ type: "draft", patch })} onContinue={() => dispatch({ type: "stage", stage: "confirm" })} />}
      {entry && state.stage === "confirm" && <TaskConfirmationStage draft={state.draft} entry={entry} runs={runs} decisions={decisions[entry.runId] ?? []} busy={busy} onDecision={updateDecision} onConfirmFacts={() => void confirmFacts()} onConfirmScope={() => void confirmScope()} onClear={() => void clearScopes()} onBack={() => dispatch({ type: "stage", stage: "prepare" })} onCreate={() => void createTask()} />}
      {!entry && <StatusBanner tone="warning">请先选择真实课次。</StatusBanner>}
    </section>}
    {state.stage === "studio" && <FeedbackTaskStudioStage semesterId={context.context.semesterId} className={context.context.className} sessionCode={context.context.sessionCode} planId={state.planId} batchId={state.batchId} context={context.data} onPlanChange={changeStudioPlan} onNewTask={() => void endAndStartNew()} />}
  </main>;
}
