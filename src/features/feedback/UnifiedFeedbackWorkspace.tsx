"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Button, PageHeader, SegmentedControl, StatusBanner, Textarea } from "@/components/ui";
import { requestJson } from "@/lib/api-client";
import {
  FEEDBACK_MODULES,
  defaultFeedbackGenerationPreferences,
  type FeedbackClosureType,
} from "@/lib/feedback-plan";
import { useLLMConfiguration } from "@/features/system/useLLMConfiguration";
import type { FeedbackIntakeDecision, FeedbackIntakeIssue } from "@/services/feedback-intake-service";
import { FeedbackContextSection } from "./FeedbackContextSection";
import { FeedbackPlanPanel } from "./FeedbackPlanPanel";
import { useFeedbackWorkspace } from "./useFeedbackWorkspace";
import styles from "./unified-feedback-workspace.module.css";

type UnifiedStage = "intake" | "review" | "studio";
type Length = "inherit" | "short" | "standard" | "detailed";
type Tone = "inherit" | "gentle" | "professional";
type UploadCandidate = { file: File; displayName: string };

interface WebkitFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

interface WebkitFileSystemFileEntry extends WebkitFileSystemEntry {
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
}

interface WebkitFileSystemDirectoryReader {
  readEntries: (success: (entries: WebkitFileSystemEntry[]) => void, failure?: (error: DOMException) => void) => void;
}

interface WebkitFileSystemDirectoryEntry extends WebkitFileSystemEntry {
  createReader: () => WebkitFileSystemDirectoryReader;
}

interface FeedbackIntakeRunView {
  id: string;
  sessionCode: string;
  status: string;
  sourceFingerprint: string;
  sourceManifest: Array<Record<string, unknown>>;
  appliedSummary: Record<string, unknown>;
  issues: FeedbackIntakeIssue[];
  planId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScriptMaterialOption {
  lessonNumber: number;
  topic: string;
  groupFeedback: string;
  assessmentBriefRaw?: string;
  perfectPrivateFeedback: string;
  errorPrivateFeedback: string;
  note: string;
  material?: { lessonTitle?: string; classroomContent?: string[]; classroomFocus?: string[]; assessmentFocus?: string[] };
}

type ApiResult = {
  run: FeedbackIntakeRunView;
  inspection?: { summary?: Record<string, unknown>; assessmentEvidence?: Record<string, unknown> };
  duplicate?: boolean;
};

const stageLabels: Record<UnifiedStage, string> = {
  intake: "收集材料",
  review: "确认事实",
  studio: "计划工作室",
};

const moduleLabels: Record<string, string> = {
  observed_moment: "具体表现",
  teacher_interpretation: "教师判断",
  teacher_intervention: "老师已经做了什么",
  intervention_outcome: "处理结果",
  parent_action: "家长最低动作",
  followup_observation: "后续观察",
};

const moduleDescriptions: Record<string, string> = {
  observed_moment: "写清本次可验证的课堂表现",
  teacher_interpretation: "解释表现背后的学习状态",
  teacher_intervention: "说明老师已经采取的处理",
  intervention_outcome: "记录处理后的变化",
  parent_action: "只在确有必要时提出家庭动作",
  followup_observation: "写明后续继续关注什么",
};

function errorMessage(error: unknown) { return error instanceof Error ? error.message : "操作失败"; }

function runDecisions(run: FeedbackIntakeRunView | null) {
  const value = run?.appliedSummary?.decisions;
  return Array.isArray(value) ? value as FeedbackIntakeDecision[] : [];
}

function issueNeedsChoice() {
  return true;
}

function issueChoiceLabel(issue: FeedbackIntakeIssue) {
  if (issue.code === "attendance_conflict") return "考勤冲突";
  if (issue.code.includes("date") || issue.code.includes("lesson")) return "课次边界";
  if (issue.code === "assessment_duplicate") return "重复 PDF";
  if (issue.code.includes("student") || issue.code.includes("identity")) return "学生匹配";
  if (issue.code.startsWith("assessment")) return "PDF 匹配";
  if (issue.code === "step_note_review") return "STEP 备注";
  return "需要教师判断";
}

async function readDirectoryEntries(entry: WebkitFileSystemDirectoryEntry, prefix = entry.name): Promise<UploadCandidate[]> {
  const reader = entry.createReader();
  const entries: WebkitFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<WebkitFileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    entries.push(...batch);
  }
  const files: UploadCandidate[] = [];
  for (const child of entries) {
    const displayName = `${prefix}/${child.name}`;
    if (child.isDirectory) files.push(...await readDirectoryEntries(child as WebkitFileSystemDirectoryEntry, displayName));
    else if (child.isFile) {
      const file = await new Promise<File>((resolve, reject) => (child as WebkitFileSystemFileEntry).file(resolve, reject));
      files.push({ file, displayName });
    }
  }
  return files;
}

async function uploadCandidatesFromDrop(dataTransfer: DataTransfer): Promise<UploadCandidate[]> {
  const candidates: UploadCandidate[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => WebkitFileSystemEntry | null }).webkitGetAsEntry?.();
    if (entry?.isDirectory) candidates.push(...await readDirectoryEntries(entry as unknown as WebkitFileSystemDirectoryEntry));
    else if (entry?.isFile) {
      const file = item.getAsFile();
      if (file) candidates.push({ file, displayName: file.name });
    }
  }
  return candidates.length ? candidates : Array.from(dataTransfer.files).map((file) => ({ file, displayName: file.name }));
}

export default function UnifiedFeedbackWorkspace({ initialStage = "intake" }: { initialStage?: UnifiedStage }) {
  const workspace = useFeedbackWorkspace("prepare");
  const llmWorkspace = useLLMConfiguration();
  const setWorkspaceActiveStep = workspace.setActiveStep;
  const contextSemesterId = workspace.context.semesterId;
  const contextSessionCode = workspace.context.sessionCode;
  const [stage, setStage] = useState<UnifiedStage>(initialStage);
  const [run, setRun] = useState<FeedbackIntakeRunView | null>(null);
  const [decisions, setDecisions] = useState<FeedbackIntakeDecision[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pendingMode, setPendingMode] = useState<"standard" | "fast">("standard");
  const [outputRequirement, setOutputRequirement] = useState("为每名入选学生生成一条可复核的家长反馈");
  const [generationMode, setGenerationMode] = useState<"standard" | "fast">("standard");
  const [length, setLength] = useState<Length>("inherit");
  const [tone, setTone] = useState<Tone>("inherit");
  const [closureType, setClosureType] = useState<FeedbackClosureType>(defaultFeedbackGenerationPreferences("event_micro").closureType);
  const [moduleKeys, setModuleKeys] = useState<string[]>(defaultFeedbackGenerationPreferences("event_micro").moduleKeys);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [commonLessonLabel, setCommonLessonLabel] = useState("");
  const [scriptOptions, setScriptOptions] = useState<ScriptMaterialOption[]>([]);
  const [selectedScriptLesson, setSelectedScriptLesson] = useState("");
  const [selectedCommonLessonId, setSelectedCommonLessonId] = useState("");
  const [materialMode, setMaterialMode] = useState<"linked_revision" | "session_snapshot" | "none">("none");
  const [autoScannedSession, setAutoScannedSession] = useState("");
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const selectionSessionRef = useRef("");
  const runRestoreRef = useRef(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const llmReady = !llmWorkspace.loading && Boolean(llmWorkspace.form.apiKey?.trim() && llmWorkspace.form.model?.trim());

  useEffect(() => {
    if (initialStage === "studio" && workspace.activeStep !== "export") {
      setWorkspaceActiveStep("export");
    }
  }, [initialStage, setWorkspaceActiveStep, workspace.activeStep]);

  const updateStage = useCallback((next: UnifiedStage) => {
    setStage(next);
    const url = new URL(window.location.href);
    url.searchParams.set("stage", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (next === "studio") setWorkspaceActiveStep("export");
  }, [setWorkspaceActiveStep]);

  async function refreshRun(id: string) {
    const result = await requestJson<{ run: FeedbackIntakeRunView }>(`/api/feedback/intake/runs/${encodeURIComponent(id)}`);
    setRun(result.run);
    setDecisions(runDecisions(result.run));
    return result.run;
  }

  const adoptRun = useCallback((nextRun: FeedbackIntakeRunView) => {
    setRun(nextRun);
    setDecisions(runDecisions(nextRun));
    const url = new URL(window.location.href);
    url.searchParams.set("intakeRunId", nextRun.id);
    if (nextRun.planId) url.searchParams.set("planId", nextRun.planId);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (nextRun.planId) updateStage("studio");
    else if (nextRun.issues.some(issueNeedsChoice)) updateStage("review");
    else updateStage("intake");
  }, [updateStage]);

  const scanInbox = useCallback(async (silent = false) => {
    const sessionCode = workspace.context.sessionCode;
    if (!sessionCode) return;
    setBusy(true); setError(""); if (!silent) setStatus("正在扫描反馈收件箱…");
    try {
      const result = await requestJson<ApiResult>("/api/feedback/intake/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionCode, ...(run?.sessionCode === sessionCode && run.id && !run.planId ? { runId: run.id } : {}) }),
      });
      adoptRun(result.run);
      setStatus(result.run.sourceManifest.length === 0 ? "反馈收件箱暂无材料；可以继续拖入或选择本次文件。" : result.run.issues.length ? "材料已读取；请只处理异常项。" : "材料已读取，等待教师确认事实。 ");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }, [adoptRun, run, workspace.context.sessionCode]);

  useEffect(() => {
    const requestedRunId = new URL(window.location.href).searchParams.get("intakeRunId");
    const requestedPlanId = new URL(window.location.href).searchParams.get("planId");
    if (requestedRunId && workspace.contextHydrated && !runRestoreRef.current) {
      runRestoreRef.current = true;
      void refreshRun(requestedRunId).then((restored) => {
        if (restored.planId) updateStage("studio");
        else if (restored.issues.some(issueNeedsChoice)) updateStage("review");
      }).catch((reason) => setError(errorMessage(reason)));
      return;
    }
    if (initialStage === "studio" && requestedPlanId) return;
    if (!workspace.contextHydrated || !workspace.context.sessionCode || autoScannedSession === workspace.context.sessionCode) return;
    if (requestedRunId) return;
    setAutoScannedSession(workspace.context.sessionCode);
    void scanInbox(true);
  }, [autoScannedSession, initialStage, scanInbox, updateStage, workspace.context.sessionCode, workspace.contextHydrated]);

  useEffect(() => {
    const semesterId = contextSemesterId;
    const sessionCode = contextSessionCode;
    if (!semesterId || !sessionCode) {
      setCommonLessonLabel(""); setScriptOptions([]); setSelectedScriptLesson(""); setSelectedCommonLessonId(""); setMaterialMode("none"); return;
    }
    let cancelled = false;
    requestJson<{ library: { entries: ScriptMaterialOption[] } | null; recommendedLessonNumber: number | null }>(`/api/feedback/script-library?semesterId=${encodeURIComponent(semesterId)}&sessionCode=${encodeURIComponent(sessionCode)}`)
      .then((data) => {
        if (cancelled) return;
        const entries = data.library?.entries ?? [];
        setScriptOptions(entries);
        const linkedLesson = workspace.groupProgress?.lesson;
        const linkedRevision = linkedLesson?.revisions?.[0];
        if (linkedLesson && linkedRevision && workspace.groupProgress?.status === "linked") {
          setSelectedCommonLessonId(linkedRevision.id);
          setMaterialMode("linked_revision");
          setCommonLessonLabel(`班级组第 ${linkedLesson.sequence} 讲 · 已确认修订 ${linkedRevision.revision}`);
          setSelectedScriptLesson(String(linkedLesson.confirmedMaterial?.scriptLessonNumber ?? linkedLesson.sequence));
        } else if (linkedLesson) {
          setSelectedCommonLessonId("");
          setMaterialMode("none");
          setCommonLessonLabel(`班级组第 ${linkedLesson.sequence} 讲 · ${linkedLesson.hasUnconfirmedChanges ? "已有草稿，待确认" : "尚未确认材料"}`);
          const recommended = entries.some((entry) => entry.lessonNumber === linkedLesson.sequence) ? linkedLesson.sequence : data.recommendedLessonNumber;
          setSelectedScriptLesson(recommended ? String(recommended) : "");
        } else if (workspace.sessionCommonMaterial?.material) {
          setSelectedCommonLessonId("");
          setMaterialMode("session_snapshot");
          setCommonLessonLabel("当前独立课次 · 已确认本课公共材料");
          setSelectedScriptLesson(String(workspace.sessionCommonMaterial.material.scriptLessonNumber ?? data.recommendedLessonNumber ?? ""));
        } else {
          setSelectedCommonLessonId("");
          setMaterialMode("none");
          setCommonLessonLabel("当前独立课次 · 尚未确认公共材料");
          setSelectedScriptLesson(data.recommendedLessonNumber ? String(data.recommendedLessonNumber) : String(entries[0]?.lessonNumber ?? ""));
        }
      })
      .catch(() => { if (!cancelled) { setCommonLessonLabel(""); setScriptOptions([]); setSelectedScriptLesson(""); setSelectedCommonLessonId(""); setMaterialMode("none"); } });
    return () => { cancelled = true; };
  }, [contextSemesterId, contextSessionCode, workspace.groupProgress, workspace.sessionCommonMaterial]);

  const selectedScript = scriptOptions.find((entry) => String(entry.lessonNumber) === selectedScriptLesson) ?? null;

  async function confirmSelectedCommonMaterial() {
    const lesson = workspace.groupProgress?.lesson;
    if (!lesson || !selectedScript) return;
    setBusy(true); setError("");
    try {
      await requestJson(`/api/group-lessons/${encodeURIComponent(lesson.id)}/common-material`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonNumber: selectedScript.lessonNumber }) });
      await requestJson(`/api/group-lessons/${encodeURIComponent(lesson.id)}/confirm`, { method: "POST" });
      setMaterialMode("linked_revision");
      setStatus(`已确认第 ${selectedScript.lessonNumber} 课公共材料，并共享给班级组其他课次。`);
      workspace.reloadContext();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function saveSelectedSessionMaterial() {
    if (!workspace.contextSessionId || !selectedScript) return;
    setBusy(true); setError("");
    try {
      await requestJson(`/api/sessions/${encodeURIComponent(workspace.contextSessionId)}/common-material`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonNumber: selectedScript.lessonNumber }) });
      setMaterialMode("session_snapshot");
      setStatus(`已将第 ${selectedScript.lessonNumber} 课公共材料保存为当前课次快照。`);
      workspace.reloadContext();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (selectionSessionRef.current === contextSessionCode) return;
    selectionSessionRef.current = contextSessionCode;
    const recommended = workspace.contextStudents.filter((student) => (student.feedbackRecommendationReasons?.length ?? 0) > 0).map((student) => student.id);
    setSelectedStudentIds(recommended);
  }, [contextSessionCode, workspace.contextStudents]);

  async function uploadFiles(files: UploadCandidate[]) {
    if (!workspace.context.sessionCode || !files.length) return;
    setBusy(true); setError(""); setStatus("正在整理文件、ZIP 和目录材料…");
    try {
      const form = new FormData();
      form.set("sessionCode", workspace.context.sessionCode);
      if (run?.sessionCode === workspace.context.sessionCode && !run.planId) form.set("runId", run.id);
      form.set("displayNames", JSON.stringify(files.map(({ displayName }) => displayName)));
      files.forEach(({ file }) => form.append("files", file, file.name));
      const result = await requestJson<ApiResult>("/api/feedback/intake/upload", { method: "POST", body: form });
      adoptRun(result.run);
      setStatus(result.run.issues.length ? "材料已读取；请处理异常项。" : "材料已读取，等待教师确认事实。 ");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  function decisionFor(issue: FeedbackIntakeIssue) {
    return decisions.find((decision) => decision.issueId === issue.id);
  }

  function setDecision(issue: FeedbackIntakeIssue, action: FeedbackIntakeDecision["action"], sourceName?: string, studentId?: string, text?: string) {
    setDecisions((current) => [...current.filter((decision) => decision.issueId !== issue.id), { issueId: issue.id, action, ...(issue.sourceName ? { sourceName: issue.sourceName } : {}), ...(sourceName ? { sourceName } : {}), ...(studentId ? { studentId } : {}), ...(text !== undefined ? { text } : {}) }]);
  }

  async function createPlan(mode: "standard" | "fast") {
    setBusy(true); setError(""); setStatus("正在创建 FeedbackPlan…");
    try {
      let currentRun = run;
      if (!currentRun) {
        const scanned = await requestJson<ApiResult>("/api/feedback/intake/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionCode: workspace.context.sessionCode }),
        });
        currentRun = scanned.run;
        setRun(currentRun);
        setDecisions(runDecisions(currentRun));
      }
      if (currentRun.status !== "applied") {
        const confirmed = await requestJson<{ result: FeedbackIntakeRunView }>(`/api/feedback/intake/runs/${encodeURIComponent(currentRun.id)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm", decisions: currentRun.id === run?.id ? decisions : runDecisions(currentRun) }),
        });
        currentRun = confirmed.result;
        adoptRun(currentRun);
      }
      const prefs = { closureType, moduleKeys, length, tone };
      const commonMaterial = materialMode === "linked_revision"
        ? { mode: "linked_revision", revisionId: selectedCommonLessonId }
        : materialMode === "session_snapshot"
          ? { mode: "session_snapshot" }
          : { mode: "none" };
      const result = await requestJson<{ result: { plan?: { id: string } } }>(`/api/feedback/intake/runs/${encodeURIComponent(currentRun.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_plan", plan: {
          type: "event_micro",
          outputRequirement,
          generationMode: mode,
          studentIds: selectedStudentIds,
          generationPreferences: prefs,
          commonMaterial,
        } }),
      });
      const planId = result.result.plan?.id;
      if (!planId) throw new Error("FeedbackPlan 创建后没有返回计划 ID");
      const next = await refreshRun(currentRun.id);
      adoptRun(next);
      try {
        await requestJson(`/api/report/feedback-plans/${encodeURIComponent(planId)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start_generation", generationMode: mode, assessmentEvidence: currentRun.appliedSummary.assessmentEvidence ?? {} }),
        });
        setStatus(mode === "fast" ? "快速草稿已开始生成，已进入计划工作室。" : "标准反馈已开始生成，已进入计划工作室。 ");
      } catch (reason) {
        setStatus("计划已创建，但生成尚未启动；可以在计划工作室重试。 ");
        setError(errorMessage(reason));
      }
      updateStage("studio");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  function startFromIntake(mode: "standard" | "fast") {
    setPendingMode(mode);
    if (run?.issues.some(issueNeedsChoice)) updateStage("review");
    else void createPlan(mode);
  }

  function restartIntake() {
    setRun(null);
    setDecisions([]);
    setError("");
    setStatus("已开始新一轮材料整理，请重新选择文件或文件夹。");
    const url = new URL(window.location.href);
    url.searchParams.delete("intakeRunId");
    url.searchParams.delete("planId");
    url.searchParams.set("stage", "intake");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    setStage("intake");
  }

  const issueCount = run?.issues.filter(issueNeedsChoice).length ?? 0;
  const unresolvedCount = run?.issues.filter(issueNeedsChoice).filter((issue) => !decisionFor(issue)).length ?? 0;
  const hasRun = Boolean(run && run.sourceManifest.length > 0);
  const summary = run?.appliedSummary ?? {};
  const recognizedCount = Number(summary.recognizedCount ?? run?.sourceManifest.filter((source) => source.kind !== "ignored").length ?? 0);
  const hasExistingFacts = workspace.contextStudents.some((student) => (student.feedbackRecommendationReasons?.length ?? 0) > 0) || materialMode !== "none";
  const hasUsableMaterial = recognizedCount > 0 || materialMode !== "none" || hasExistingFacts;
  const canStart = Boolean(hasUsableMaterial && hasExistingFacts && llmReady && (!run || run.status !== "failed") && !busy && selectedStudentIds.length > 0);

  function renderRail() {
    return <nav className={styles.taskRail} aria-label="课后任务阶段">
      {(["intake", "review", "studio"] as UnifiedStage[]).map((item, index) => <button type="button" key={item} className={stage === item ? styles.activeRail : ""} onClick={() => (item === "studio" && !run?.planId ? undefined : updateStage(item))} disabled={item === "studio" && !run?.planId}><span>{index + 1}</span><strong>{stageLabels[item]}</strong><small>{item === "intake" ? "统一投料" : item === "review" ? "只处理异常" : "逐学生复核"}</small></button>)}
    </nav>;
  }

  function renderIntake() {
    return <>
      <div className={styles.entrances}>
        <section className={styles.dropzone} onClick={() => uploadRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadCandidatesFromDrop(event.dataTransfer).then(uploadFiles).catch((reason) => setError(errorMessage(reason))); }}>
          <span className={styles.eyebrow}>入口 A · 临时投入</span><strong>拖入文件、文件夹或 ZIP</strong><p>助教 Excel、STEP 文本、学生 PDF；ZIP 内支持这些文件类型。</p><Button variant="secondary" disabled={busy || !workspace.context.sessionCode}>选择材料</Button>
          <input ref={uploadRef} hidden type="file" multiple accept=".xlsx,.txt,.step-classroom.txt,.pdf,.zip" onChange={(event) => { void uploadFiles(Array.from(event.target.files ?? []).map((file) => ({ file, displayName: file.webkitRelativePath || file.name }))); event.currentTarget.value = ""; }} />
        </section>
        <section className={styles.inbox}>
          <span className={styles.eyebrow}>入口 B · 固定目录</span><strong>读取反馈收件箱</strong><code>~/Library/Application Support/Student Track/feedback-inbox</code><Button variant="secondary" disabled={busy || !workspace.context.sessionCode} onClick={() => void scanInbox()}>重新扫描</Button><small>不移动、不删除原文件；材料先汇总，确认事实后才写入。</small>
        </section>
      </div>
      <div className={styles.folderRow}><Button variant="ghost" uiSize="sm" onClick={() => folderRef.current?.click()} disabled={busy || !workspace.context.sessionCode}>选择整个报告文件夹</Button><span>适合一次导入一批学生 PDF；会递归读取子目录，但不会持续监听。</span><input ref={folderRef} hidden type="file" multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} accept=".pdf" onChange={(event) => { void uploadFiles(Array.from(event.target.files ?? []).map((file) => ({ file, displayName: file.webkitRelativePath || file.name }))); event.currentTarget.value = ""; }} /></div>
      {hasRun && run && <section className={styles.runSummary}><div><strong>本轮材料</strong><span>{run.sourceManifest.length} 个来源 · {String(summary.appliedStudentCount ?? 0)} 名学生事实已整理</span></div><div className={styles.fileList}>{run.sourceManifest.map((file, index) => <span key={`${String(file.name)}:${String(file.sourceHash ?? index)}`}><Badge tone={file.kind === "ignored" ? "neutral" : file.kind === "assessment_pdf" ? "info" : "success"}>{file.kind === "ignored" ? "忽略" : file.kind === "assessment_pdf" ? "PDF" : file.kind === "step_classroom" ? "STEP" : "助教表"}</Badge>{String(file.name)}</span>)}</div></section>}
      <section className={styles.candidates}><header><div><strong>本次反馈对象</strong><span>先明确入选学生，创建计划时不再静默猜测。</span></div><div><Button uiSize="sm" variant="ghost" onClick={() => setSelectedStudentIds(workspace.contextStudents.map((student) => student.id))}>全选</Button><Button uiSize="sm" variant="ghost" onClick={() => setSelectedStudentIds([])}>清空</Button></div></header><div className={styles.candidateGrid}>{workspace.contextStudents.length ? workspace.contextStudents.map((student) => <label key={student.id} className={selectedStudentIds.includes(student.id) ? styles.candidateSelected : ""}><input type="checkbox" checked={selectedStudentIds.includes(student.id)} onChange={(event) => setSelectedStudentIds((ids) => event.target.checked ? [...new Set([...ids, student.id])] : ids.filter((id) => id !== student.id))} /><span><strong>{student.name}</strong><small>{student.feedbackRecommendationReasons?.length ? student.feedbackRecommendationReasons.join("、") : "有课堂记录，可手动加入"}</small></span></label>) : <span>正在读取当前课次学生…</span>}</div></section>
      <section className={styles.strategy}>
        <div className={styles.strategyHeading}><div><strong>课程公共材料</strong><span>只作为课程背景；确认后复制进本次 FeedbackPlan 快照，不会成为学生证据。</span></div><Badge tone={materialMode === "none" ? "neutral" : "success"}>{materialMode === "none" ? "本次不使用" : "已选择"}</Badge></div>
        <p className={styles.commonLesson}>{commonLessonLabel}</p>
        {workspace.groupProgress?.lesson && <div className={styles.commonLessonPicker}>
          <label>选择当前共同课公共材料<select value={materialMode === "none" ? "" : selectedScriptLesson} onChange={(event) => { setSelectedScriptLesson(event.target.value); if (!event.target.value) { setMaterialMode("none"); setSelectedCommonLessonId(""); } }}><option value="">本次不使用</option>{scriptOptions.map((entry) => <option key={entry.lessonNumber} value={entry.lessonNumber}>第 {entry.lessonNumber} 课{entry.topic ? ` · ${entry.topic}` : ""}</option>)}</select></label>
          {materialMode === "linked_revision" && workspace.groupProgress.lesson.confirmedMaterial && <div className={styles.commonLessonPreview}>{workspace.groupProgress.lesson.confirmedMaterial.groupFeedbackRaw || "已确认公共材料，但暂无群反馈原文。"}</div>}
          {selectedScript && <><small>{materialMode === "linked_revision" ? "可改选话术库课次；保存后会形成新的共同课确认修订。" : `这是班级组第 ${workspace.groupProgress.lesson.sequence} 讲的材料草稿，确认后同组其他班直接继承。`}</small>{materialMode !== "linked_revision" || String(workspace.groupProgress.lesson.confirmedMaterial?.scriptLessonNumber ?? "") !== selectedScriptLesson ? <><div className={styles.commonLessonPreview}>{selectedScript.groupFeedback || "暂无群反馈"}</div><Button variant="secondary" onClick={() => void confirmSelectedCommonMaterial()} disabled={busy}>{materialMode === "linked_revision" ? "更新并确认本讲材料" : "确认并共享本讲材料"}</Button></> : null}</>}
        </div>}
        {!workspace.groupProgress?.lesson && <div className={styles.commonLessonPicker}>
          <label>选择本课公共材料<select value={selectedScriptLesson} onChange={(event) => setSelectedScriptLesson(event.target.value)}><option value="">不使用</option>{scriptOptions.map((entry) => <option key={entry.lessonNumber} value={entry.lessonNumber}>第 {entry.lessonNumber} 课{entry.topic ? ` · ${entry.topic}` : ""}</option>)}</select></label>
          {materialMode === "session_snapshot" && workspace.sessionCommonMaterial?.material && <div className={styles.commonLessonPreview}>{workspace.sessionCommonMaterial.material.groupFeedbackRaw || "已确认本课公共材料，但暂无群反馈原文。"}</div>}
          {selectedScript && <><small>独立课次需要教师明确保存；不会自动套用。</small><div className={styles.commonLessonPreview}>{selectedScript.groupFeedback || "暂无群反馈"}</div><Button variant="secondary" onClick={() => void saveSelectedSessionMaterial()} disabled={busy || !workspace.contextSessionId}>保存为本课公共材料</Button></>}
        </div>}
        {materialMode !== "none" && <div className={styles.commonLessonPicker}><small>本次将使用当前课次实际关联的公共材料。若不需要，可选择“本次不使用”。</small><Button variant="ghost" uiSize="sm" onClick={() => { setMaterialMode("none"); setSelectedCommonLessonId(""); }}>本次不使用公共材料</Button></div>}
        <div className={styles.strategyHeading}><div><strong>本次反馈策略</strong><span>整批设置进入计划快照，逐学生覆盖仍在计划工作室保留。</span></div><Button variant="ghost" uiSize="sm" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "收起全部计划设置" : "展开全部计划设置"}</Button></div>
        <div className={styles.strategyRows}><label>详略<SegmentedControl label="反馈详略" value={length} onChange={(value) => setLength(value as Length)} items={[{ value: "inherit", label: "随家庭偏好" }, { value: "short", label: "简洁" }, { value: "standard", label: "标准" }, { value: "detailed", label: "详细" }]} /></label><label>语气<SegmentedControl label="反馈语气" value={tone} onChange={(value) => setTone(value as Tone)} items={[{ value: "inherit", label: "随家庭偏好" }, { value: "gentle", label: "温和" }, { value: "professional", label: "专业" }]} /></label></div>
        <div className={styles.strategyGrid}><label>生成方式<select value={generationMode} onChange={(event) => setGenerationMode(event.target.value as "standard" | "fast")}><option value="standard">标准反馈（含审核）</option><option value="fast">快速草稿（跳过审核润色）</option></select></label><label>结尾<select value={closureType} onChange={(event) => setClosureType(event.target.value as FeedbackClosureType)}><option value="positive_recognition">具体认可</option><option value="teacher_resolved">课堂已处理</option><option value="home_cooperation">家庭配合</option><option value="continued_observation">后续观察</option></select></label><label className={styles.requirement}>总体要求<Textarea rows={2} value={outputRequirement} onChange={(event) => setOutputRequirement(event.target.value)} /></label></div>{showAdvanced && <div className={styles.moduleGrid}>{FEEDBACK_MODULES.event_micro.map((key) => <label key={key} className={moduleKeys.includes(key) ? styles.moduleSelected : ""}><input type="checkbox" checked={moduleKeys.includes(key)} onChange={(event) => setModuleKeys((current) => event.target.checked ? [...new Set([...current, key])] : current.filter((item) => item !== key))} /><span><strong>{moduleLabels[key] ?? key}</strong><small>{moduleDescriptions[key] ?? "决定反馈关注内容"}</small></span></label>)}</div>}
      </section>
      {!llmWorkspace.loading && !llmReady && <StatusBanner tone="danger"><span>尚未配置可用的 LLM API Key 与模型，创建计划后将无法生成正文。</span> <Link href="/system/configuration">前往系统中心配置</Link></StatusBanner>}
      {hasRun && !hasUsableMaterial && <StatusBanner tone="warning">本轮只有未识别或已忽略的文件；如果当前课次也没有已确认课堂事实，请先补充材料。</StatusBanner>}
      <footer className={styles.actions}><div><strong>{issueCount ? `有 ${issueCount} 项异常需要确认` : hasRun ? "材料已整理，等待事实确认" : hasExistingFacts ? "沿用当前课次已确认事实" : "先选择课次和材料"}</strong><span>确认前不写入课堂事实；确认后进入同一个 FeedbackPlan。</span></div><div><Button variant="secondary" onClick={() => startFromIntake("fast")} disabled={!canStart}>{busy ? "处理中…" : "快速生成草稿"}</Button><Button onClick={() => startFromIntake("standard")} disabled={!canStart}>{busy ? "处理中…" : issueCount ? "检查并开始标准反馈" : "开始标准反馈"}</Button></div></footer>
    </>;
  }

  function renderIssueChoices(item: FeedbackIntakeIssue, selected?: FeedbackIntakeDecision) {
    if (item.code === "step_note_review") {
      return <div className={styles.observationChoices}>
        <label><input type="radio" name={item.id} checked={selected?.action === "use_observation"} onChange={() => setDecision(item, "use_observation")} /> 采用为课堂观察</label>
        <label><input type="radio" name={item.id} checked={selected?.action === "ignore_observation"} onChange={() => setDecision(item, "ignore_observation")} /> 忽略这条自由备注</label>
        <label><input type="radio" name={item.id} checked={selected?.action === "edit_observation"} onChange={() => setDecision(item, "edit_observation", undefined, undefined, item.message)} /> 手动编辑后采用</label>
        {selected?.action === "edit_observation" && <Textarea aria-label="编辑课堂观察" rows={3} value={selected.text ?? ""} onChange={(event) => setDecision(item, "edit_observation", undefined, undefined, event.target.value)} />}
      </div>;
    }
    if (item.code === "attendance_conflict") {
      return <>
        <label><input type="radio" name={item.id} checked={selected?.action === "use_assistant"} onChange={() => setDecision(item, "use_assistant")} /> 采用助教表</label>
        <label><input type="radio" name={item.id} checked={selected?.action === "use_step"} onChange={() => setDecision(item, "use_step")} /> 采用 STEP</label>
        <label><input type="radio" name={item.id} checked={selected?.action === "skip_attendance"} onChange={() => setDecision(item, "skip_attendance")} /> 本次不写考勤</label>
      </>;
    }
    if (item.code === "assessment_duplicate") {
      const studentId = item.message.match(/^学生 ([^ ]+) 存在多份 PDF/)?.[1];
      return <>
        <label><input type="radio" name={item.id} checked={selected?.action === "select_pdf"} onChange={() => setDecision(item, "select_pdf", item.sourceName, studentId)} /> 选择这份 PDF</label>
        <label><input type="radio" name={item.id} checked={selected?.action === "ignore_source"} onChange={() => setDecision(item, "ignore_source")} /> 忽略这份 PDF（保留已选）</label>
      </>;
    }
    if (item.candidates?.length) {
      return <>
        <label>绑定学生<select value={selected?.action === "bind_student" ? selected.studentId ?? "" : ""} onChange={(event) => { if (event.target.value) setDecision(item, "bind_student", item.sourceName, event.target.value); }}>
          <option value="">请选择当前班学生</option>
          {item.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.studentId}</option>)}
        </select></label>
        <label><input type="radio" name={item.id} checked={selected?.action === "ignore_source"} onChange={() => setDecision(item, "ignore_source")} /> 忽略该条</label>
      </>;
    }
    return <>
      <label><input type="radio" name={item.id} checked={selected?.action === "ignore_source"} onChange={() => setDecision(item, "ignore_source")} /> 忽略这份来源</label>
      <label><input type="radio" name={item.id} checked={selected?.action === "accept_source"} onChange={() => setDecision(item, "accept_source")} /> 接受为当前课次</label>
    </>;
  }

  function renderReview() {
    return <div className={styles.reviewStage}>
      <div className={styles.summaryStrip}>
        <div><strong>{String(summary.appliedStudentCount ?? 0)}</strong><span>已整理学生</span></div>
        <div><strong>{String(summary.assessmentStudentCount ?? 0)}</strong><span>PDF 证据</span></div>
        <div><strong>{issueCount}</strong><span>需要教师判断</span></div>
        <div><strong>{unresolvedCount}</strong><span>尚未选择</span></div>
      </div>
      <StatusBanner tone="warning">只处理下面的异常；无冲突材料已经整理，未选择前不会写入。</StatusBanner>
      <div className={styles.issueList}>
        {(run?.issues ?? []).filter(issueNeedsChoice).map((item) => {
          const selected = decisionFor(item);
          return <article key={item.id}>
            <header><div><Badge tone={item.severity === "error" ? "danger" : "warning"}>{issueChoiceLabel(item)}</Badge><strong>{item.message}</strong></div><small>{item.sourceName ?? "本轮材料"}</small></header>
            <div className={styles.choiceRow}>{renderIssueChoices(item, selected)}</div>
          </article>;
        })}
      </div>
      <details className={styles.allFacts}><summary>查看全部已整理事实（{String(summary.appliedStudentCount ?? 0)} 名学生）</summary><p>来源事实只会在确认后进入当前课次；模型候选、坐标和未确认备注不会自动写入。</p><div className={styles.factSources}>{Array.isArray(summary.sourceFacts) ? (summary.sourceFacts as Array<Record<string, unknown>>).map((fact, index) => <article key={`${String(fact.kind)}-${index}`}><strong>{fact.kind === "assistant_roster" ? "助教表" : fact.kind === "step_classroom" ? "STEP 课堂事实" : "PDF 证据"}</strong><span>{Array.isArray(fact.sourceNames) ? fact.sourceNames.join("、") : "本轮材料"}</span><small>{Array.isArray(fact.students) ? `${fact.students.length} 名学生` : Array.isArray(fact.assessmentEvidence) ? `${fact.assessmentEvidence.length} 份报告` : "已解析"}</small></article>) : <span>暂无可写入事实</span>}</div></details>
      <footer className={styles.actions}>
        <div><strong>确认后固定本次事实快照</strong><span>{unresolvedCount ? `还有 ${unresolvedCount} 项必须选择` : "已完成所有必要选择"}</span></div>
        <div><Button variant="ghost" onClick={() => updateStage("intake")} disabled={busy}>返回材料</Button><Button variant="ghost" onClick={restartIntake} disabled={busy}>重新解析本次材料</Button><Button onClick={() => void createPlan(pendingMode)} disabled={busy || unresolvedCount > 0 || !selectedStudentIds.length || !llmReady}>{busy ? "确认中…" : `确认事实并开始${pendingMode === "fast" ? "快速" : "标准"}反馈`}</Button></div>
      </footer>
    </div>;
  }

  function renderStudio() {
    return <section className={styles.studioStage}><header className={styles.studioHeader}><div><span className={styles.eyebrow}>第三阶段</span><h2>计划工作室</h2><p>左侧按学生和状态定位，右侧集中处理证据、正文、独立设置、重试、批准与导出。</p></div><Link href="/feedback/advanced" className="ui-button ui-button--ghost ui-button--md">打开高级工作台</Link></header><FeedbackPlanPanel workspace={workspace} presentation="studio" /></section>;
  }

  return <main className={styles.page}>
    <PageHeader title="课后任务" description="一次投入材料，统一确认事实，再进入可完整微操的反馈计划。" actions={<div className={styles.headerActions}><Badge tone="info">1.2.0</Badge><Link href="/feedback/advanced" className="ui-button ui-button--ghost ui-button--md">高级工作台</Link></div>} />
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {status && <StatusBanner tone="success">{status}</StatusBanner>}
    <FeedbackContextSection workspace={workspace} />
    <section className={styles.taskCard}><header className={styles.taskHeader}><div><span className={styles.eyebrow}>当前课后任务</span><h2>{workspace.context.className || "选择班级"} · {workspace.context.sessionCode || "选择课次"}</h2><p>所有材料、课堂事实、共同课快照和反馈计划都围绕当前课次。</p></div><div className={styles.headerStatus}>{run?.planId ? <Badge tone="success">已进入计划工作室</Badge> : issueCount ? <Badge tone="warning">{issueCount} 项需处理</Badge> : hasRun ? <Badge tone="info">等待事实确认</Badge> : <Badge tone="neutral">等待材料</Badge>}</div></header>{renderRail()}<div className={styles.stageContent}>{stage === "intake" && renderIntake()}{stage === "review" && renderReview()}{stage === "studio" && renderStudio()}</div></section>
  </main>;
}
