"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import packageMetadata from "../../../package.json";
import SemesterPicker from "@/components/SemesterPicker";
import { Badge, Button, Input, PageHeader, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
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

function initialState(): FeedbackTaskState {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const planId = params.get("planId") ?? "";
  const batchId = params.get("batchId") ?? "";
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

export default function FeedbackTaskWorkspace() {
  const context = useFeedbackTaskContext();
  const [state, dispatch] = useReducer(feedbackTaskReducer, undefined, initialState);
  const [runs, setRuns] = useState<Record<string, FeedbackIntakeRunClient>>({});
  const [decisions, setDecisions] = useState<Record<string, FeedbackIntakeDecision[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const restored = useRef(false);
  const initializedStudents = useRef(new Set<string>());
  const initializedMaterialSession = useRef("");
  const entry = activeTaskEntry(state);
  const groupLesson = context.data?.groupProgress?.lesson;
  const group = context.data?.groupProgress?.group;

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
    if (saved) dispatch({ type: "restore", draft: saved });
  }, [context.hydrated, state.batchId, state.planId]);

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
      if (state.draft.activeSessionCode !== session.code) dispatch({ type: "draft", patch: { activeSessionCode: session.code } });
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
    dispatch({ type: "entries", entries: state.draft.mode === "single" ? [current] : [...state.draft.entries, current] });
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

  function setGroupMode(enabled: boolean) {
    if (!enabled || !groupLesson || !group) {
      const current = state.draft.entries.find((item) => item.sessionCode === context.context.sessionCode);
      dispatch({ type: "draft", patch: { mode: "single", groupLessonId: "", entries: current ? [current] : [], activeSessionCode: current?.sessionCode ?? context.context.sessionCode } });
      return;
    }
    const previous = new Map(state.draft.entries.map((item) => [item.sessionCode, item]));
    const entries = (group.members ?? []).flatMap((member) => member.session ? [{
      classId: member.classId,
      classCode: member.classCode,
      className: member.className ?? member.classCode,
      sessionCode: member.session.code,
      runId: previous.get(member.session.code)?.runId ?? "",
      studentIds: previous.get(member.session.code)?.studentIds ?? [],
      selected: previous.get(member.session.code)?.selected ?? true,
    }] : []);
    dispatch({ type: "draft", patch: { mode: "group", groupLessonId: groupLesson.id, entries, activeSessionCode: context.context.sessionCode } });
  }

  function switchEntry(next: FeedbackTaskClassDraft) {
    dispatch({ type: "draft", patch: { activeSessionCode: next.sessionCode } });
    context.switchSession({ className: next.className, sessionCode: next.sessionCode });
  }

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
      const targets = state.draft.entries.filter((item) => item.selected && item.runId);
      const results = await Promise.all(targets.map((item) => requestJson<{ result: FeedbackIntakeRunClient }>(`/api/feedback/intake/runs/${encodeURIComponent(item.runId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear_scope" }) })));
      setRuns((current) => Object.assign({}, current, ...results.map((result) => ({ [result.result.id]: result.result }))));
      dispatch({ type: "stage", stage: "prepare" });
      setNotice("已清除本轮班级范围；已确认课堂事实仍保留。 ");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function createTask() {
    const selectedEntries = state.draft.entries.filter((item) => item.selected && item.runId);
    setBusy(true); setError(""); setNotice("任务正在落账，随后启动生成…");
    try {
      const result = await requestJson<{ taskType: "plan" | "batch"; planId: string | null; firstPlanId?: string | null; batchId: string | null; generationStatus: string; warning?: string }>("/api/feedback/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: state.draft.mode,
          ...(state.draft.mode === "group" ? { groupLessonId: state.draft.groupLessonId } : {}),
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
  const materialLabel = state.draft.materialSelection.mode === "none" ? "本次不使用公共材料" : context.data?.groupProgress?.lesson ? `班级组第 ${context.data.groupProgress.lesson.sequence} 讲 · 已确认修订 ${context.data.groupProgress.lesson.revision}` : "使用当前独立课次已确认公共材料";

  return <main className={styles.page}>
    <PageHeader title="课后任务" description="准备任务，核对并确认，再进入生成与复核。全程只有这一套工作流。" actions={<div className={styles.headerActions}><Badge tone="info">{packageMetadata.version}</Badge><Link className="ui-button ui-button--ghost ui-button--md" href="/feedback/tools">高级工具</Link></div>} />
    <details><summary>当前反馈任务</summary><FeedbackPlanManager semesterId={context.context.semesterId} /></details>
    {(error || context.error) && <StatusBanner tone="danger">{error || context.error}</StatusBanner>}{notice && <StatusBanner tone="info">{notice}</StatusBanner>}
    {state.stage !== "studio" && <section className={styles.taskCard}>
      <div className="feedback-context-section"><SemesterPicker semesterId={context.context.semesterId} onSemesterChange={context.setSemesterId} className={context.context.className} onClassChange={context.setClassName} sessionCode={context.context.sessionCode} onSessionChange={context.setSessionCode} refreshKey={0} /><div className="feedback-new-session"><label htmlFor="task-new-session">新课次日期</label><Input id="task-new-session" type="date" value={context.newSessionDate} onChange={(event) => context.setNewSessionDate(event.target.value)} /><Button variant="secondary" onClick={() => void context.createSession()} disabled={context.creatingSession}>{context.creatingSession ? "新建中…" : "新建课次"}</Button></div></div>
      {groupLesson && group && <section className={styles.groupScope}><header><label><input type="checkbox" checked={state.draft.mode === "group"} onChange={(event) => setGroupMode(event.target.checked)} /><strong>按班级组处理本讲反馈</strong></label><span>{group.name} · 第 {groupLesson.sequence} 讲</span></header><p>共同材料和反馈策略只设置一次；每班材料、事实、学生、PDF、复核与导出独立。</p>{state.draft.mode === "group" && <div className={styles.groupClasses}>{state.draft.entries.map((item) => <article key={item.sessionCode} className={item.sessionCode === entry?.sessionCode ? styles.groupClassActive : ""}><label><input type="checkbox" checked={item.selected} onChange={(event) => dispatch({ type: "entry", sessionCode: item.sessionCode, patch: { selected: event.target.checked } })} /><span><strong>{item.className}</strong><small>{item.sessionCode}{item.runId ? " · 材料已读取" : " · 等待材料"}</small></span></label><Button uiSize="sm" variant="ghost" onClick={() => switchEntry(item)}>处理本班</Button></article>)}</div>}</section>}
      <nav className={styles.taskRail} aria-label="反馈任务阶段"><button type="button" className={state.stage === "prepare" ? styles.activeRail : ""} onClick={() => dispatch({ type: "stage", stage: "prepare" })}><span>1</span><strong>准备任务</strong><small>统一投料</small></button><button type="button" className={state.stage === "confirm" ? styles.activeRail : ""} disabled={!currentRun} onClick={() => dispatch({ type: "stage", stage: "confirm" })}><span>2</span><strong>核对并确认</strong><small>事实与范围</small></button><button type="button" disabled><span>3</span><strong>生成与复核</strong><small>计划工作室</small></button></nav>
      {entry && state.stage === "prepare" && <TaskPreparationStage draft={state.draft} entry={entry} run={currentRun} students={context.data?.students ?? []} busy={busy} commonMaterialLabel={materialLabel} commonMaterialPreview={material?.groupFeedbackRaw ?? ""} availableMaterial={availableMaterial} onFiles={(files) => void uploadFiles(files)} onScan={() => void scanInbox()} onEntry={(patch) => dispatch({ type: "entry", sessionCode: entry.sessionCode, patch })} onDraft={(patch) => dispatch({ type: "draft", patch })} onContinue={() => dispatch({ type: "stage", stage: "confirm" })} />}
      {entry && state.stage === "confirm" && <TaskConfirmationStage draft={state.draft} entry={entry} runs={runs} decisions={decisions[entry.runId] ?? []} busy={busy} onSwitch={switchEntry} onDecision={updateDecision} onConfirmFacts={() => void confirmFacts()} onConfirmScope={() => void confirmScope()} onClear={() => void clearScopes()} onBack={() => dispatch({ type: "stage", stage: "prepare" })} onCreate={() => void createTask()} />}
      {!entry && <StatusBanner tone="warning">请先选择真实课次。</StatusBanner>}
    </section>}
    {state.stage === "studio" && <FeedbackTaskStudioStage semesterId={context.context.semesterId} className={context.context.className} sessionCode={context.context.sessionCode} planId={state.planId} batchId={state.batchId} context={context.data} onPlanChange={changeStudioPlan} onNewTask={() => void endAndStartNew()} />}
  </main>;
}
