"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FeedbackContextStudent } from "@/features/feedback/context-types";
import { teachingContextWorkspaceKey } from "@/features/teaching-context/url-context";
import { useTeachingContext } from "@/features/teaching-context/use-teaching-context";
import { useAiWorkflow } from "@/features/ai-workflow";
import { requestJson } from "@/lib/api-client";
import {
  createEmptyLessonFeedbackMaterial,
  parseLessonFeedbackMaterial,
  type LessonFeedbackMaterial,
} from "@/lib/feedback-materials";
import { readSSEStream } from "@/lib/sse";
import { ParseStreamEventSchema } from "@/lib/contracts/classroom-parse";
import type { DraftReviewResult, DraftStructuredResult, NameCorrection, TeacherIntervention } from "@/lib/types";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import type { FeedbackContextResponse, FeedbackStep, FeedbackStudentOption, FeedbackWorkspaceState } from "./types";
import { useAssessmentPdfImports } from "./useAssessmentPdfImports";
import { isFeedbackWorkspace, todayLocalDate } from "./workspace-state";
import { createFeedbackWorkspaceCoreState, feedbackWorkspaceCoreReducer } from "./feedback-workspace-reducer";

function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

export function useFeedbackWorkspace(initialStep?: FeedbackStep) {
  const { context, hydrated: contextHydrated, setSemesterId, setClassName, setSessionCode } = useTeachingContext();
  const { semesterId, className, sessionCode } = context;
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const requestedStep = useRef<FeedbackStep | undefined>(initialStep);
  const [creatingSession, setCreatingSession] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [assistantImporting, setAssistantImporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [coreState, dispatchCore] = useReducer(
    feedbackWorkspaceCoreReducer,
    initialStep,
    (step) => ({ ...createFeedbackWorkspaceCoreState(step ?? "prepare"), newSessionDate: todayLocalDate() }),
  );
  const {
    activeStep, newSessionDate, rawText, parseStatus, streamContent, draftId, parsedResult,
    reviewResult, corrections, confirmed, status, groupFeedbackRaw, assessmentBriefRaw, lessonMaterial,
  } = coreState;
  const patchCore = (patch: Partial<typeof coreState>) => dispatchCore({ type: "patch", patch });
  const setActiveStep = (value: FeedbackStep) => patchCore({ activeStep: value });
  const setNewSessionDate = (value: string) => patchCore({ newSessionDate: value });
  const setRawText = (value: string) => patchCore({ rawText: value });
  const setParseStatus = (value: string) => patchCore({ parseStatus: value });
  const setStreamContent = (value: string) => patchCore({ streamContent: value });
  const setDraftId = (value: string) => patchCore({ draftId: value });
  const setParsedResult = (value: DraftStructuredResult | null) => patchCore({ parsedResult: value });
  const setReviewResult = (value: DraftReviewResult | null) => patchCore({ reviewResult: value });
  const setCorrections = (value: NameCorrection[]) => patchCore({ corrections: value });
  const setConfirmed = (value: boolean) => patchCore({ confirmed: value });
  const setStatus = (value: string) => patchCore({ status: value });
  const setGroupFeedbackRaw = (value: string) => patchCore({ groupFeedbackRaw: value });
  const setAssessmentBriefRaw = (value: string) => patchCore({ assessmentBriefRaw: value });
  const setLessonMaterial = (value: LessonFeedbackMaterial) => patchCore({ lessonMaterial: value });
  const [contextStudents, setContextStudents] = useState<FeedbackContextStudent[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [contextReloadKey, setContextReloadKey] = useState(0);
  const [students, setStudents] = useState<FeedbackStudentOption[]>([]);
  const [legacyDraftAvailable, setLegacyDraftAvailable] = useState(false);
  const workflow = useAiWorkflow();

  const assessmentStudents = useMemo<FeedbackStudentOption[]>(() => contextStudents.map((student) => ({
    id: student.id,
    name: student.name,
    studentId: student.studentId,
    class: className,
  })), [className, contextStudents]);
  const markInputsChanged = (message = "") => { if (message) setStatus(message); };
  const assessmentPdfs = useAssessmentPdfImports({
    sessionCode,
    students: assessmentStudents,
    onInputsChanged: () => markInputsChanged("测评证据已更新；创建反馈计划时会写入快照。"),
    setError,
    setStatus,
  });
  const confirmedAssessmentEvidence = assessmentPdfs.evidenceByStudent;
  const workspaceValue = useMemo<FeedbackWorkspaceState>(() => ({
    activeStep,
    context,
    newSessionDate,
    rawText,
    parseStatus,
    streamContent,
    draftId,
    parsedResult,
    reviewResult,
    corrections,
    confirmed,
    status,
    workflow: workflow.state,
    groupFeedbackRaw,
    assessmentBriefRaw,
    lessonMaterial,
    assessmentImports: assessmentPdfs.items,
  }), [activeStep, assessmentBriefRaw, assessmentPdfs.items, context, corrections, draftId, groupFeedbackRaw, lessonMaterial, newSessionDate, parseStatus, parsedResult, rawText, reviewResult, status, streamContent, confirmed, workflow.state]);

  const workspace = useSessionWorkspace({
    key: teachingContextWorkspaceKey("feedback", context),
    value: workspaceValue,
    validate: isFeedbackWorkspace,
    enabled: contextHydrated,
    restore: (saved) => {
      setActiveStep(requestedStep.current ?? saved?.activeStep ?? "prepare");
      requestedStep.current = undefined;
      setNewSessionDate(saved?.newSessionDate ?? todayLocalDate());
      setRawText(saved?.rawText ?? "");
      setParseStatus(saved?.parseStatus ?? "");
      setStreamContent(saved?.streamContent ?? "");
      setDraftId(saved?.draftId ?? "");
      setParsedResult(saved?.parsedResult ?? null);
      setReviewResult(saved?.reviewResult ?? null);
      setCorrections(saved?.corrections ?? []);
      setConfirmed(saved?.confirmed ?? false);
      setStatus(saved?.status ?? "");
      setGroupFeedbackRaw(saved?.groupFeedbackRaw ?? "");
      setAssessmentBriefRaw(saved?.assessmentBriefRaw ?? "");
      setLessonMaterial(saved?.lessonMaterial ? { ...saved.lessonMaterial, sessionCode: saved.context.sessionCode } : createEmptyLessonFeedbackMaterial(saved?.context.sessionCode));
      assessmentPdfs.setItems(saved?.assessmentImports ?? []);
      workflow.restore(saved?.workflow);
      setError("");
    },
  });

  useEffect(() => {
    if (!workspace.hydrated) return;
    const draft = sessionStorage.getItem("student-track:feedback-draft") ?? sessionStorage.getItem("chem-track:feedback-draft");
    const legacyDraft = sessionStorage.getItem("student-track:nl-input-draft") ?? sessionStorage.getItem("chem-track:nl-input-draft");
    if (draft) {
      dispatchCore({ type: "patch", patch: { rawText: draft, parseStatus: "已从当前标签页草案载入课堂回顾。" } });
      sessionStorage.removeItem("student-track:feedback-draft"); sessionStorage.removeItem("chem-track:feedback-draft");
      setLegacyDraftAvailable(Boolean(legacyDraft));
    } else if (legacyDraft) setLegacyDraftAvailable(true);
  }, [workspace.hydrated]);

  useEffect(() => {
    if (!workspace.hydrated) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("step") !== activeStep) { url.searchParams.set("step", activeStep); window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`); }
  }, [activeStep, workspace.hydrated]);

  useEffect(() => {
    if (!contextHydrated || !semesterId) { setStudents([]); return; }
    const query = new URLSearchParams({ scope: "active", semesterId });
    requestJson<FeedbackStudentOption[]>(`/api/students?${query}`).then(setStudents).catch(() => setStudents([]));
  }, [contextHydrated, semesterId]);

  useEffect(() => {
    if (!sessionCode) { setContextStudents([]); setContextError(""); return; }
    let cancelled = false;
    setContextLoading(true); setContextError("");
    requestJson<FeedbackContextResponse>(`/api/report/feedback-context?sessionCode=${encodeURIComponent(sessionCode)}&semesterId=${encodeURIComponent(semesterId)}`)
      .then((data) => { if (!cancelled) setContextStudents(data.students ?? []); })
      .catch((reason) => { if (!cancelled) { setContextStudents([]); setContextError(errorMessage(reason, "读取反馈上下文失败")); } })
      .finally(() => { if (!cancelled) setContextLoading(false); });
    return () => { cancelled = true; };
  }, [contextReloadKey, semesterId, sessionCode]);

  function withoutLessonSummary(material: LessonFeedbackMaterial) {
    const { lessonSummary: _summary, lessonSummarySourceHash: _hash, lessonSummaryStatus: _status, ...source } = material;
    void _summary; void _hash; void _status;
    return source;
  }
  function updateGroupFeedbackRaw(value: string) { setGroupFeedbackRaw(value); setLessonMaterial(withoutLessonSummary(lessonMaterial)); }
  function updateAssessmentBriefRaw(value: string) { setAssessmentBriefRaw(value); setLessonMaterial(withoutLessonSummary(lessonMaterial)); }
  function organizeLessonMaterial() { setLessonMaterial({ ...parseLessonFeedbackMaterial(groupFeedbackRaw, assessmentBriefRaw, sessionCode), scriptLessonNumber: lessonMaterial.scriptLessonNumber, perfectPrivateTemplate: lessonMaterial.perfectPrivateTemplate, errorPrivateTemplate: lessonMaterial.errorPrivateTemplate }); setStatus("课程材料已整理，可在创建反馈计划时固化。"); }
  function clearLessonMaterials() { setGroupFeedbackRaw(""); setAssessmentBriefRaw(""); setLessonMaterial(createEmptyLessonFeedbackMaterial(sessionCode)); setStatus("课程材料已清空。"); }
  function updateLessonMaterialSection(key: "lessonTitle" | "classroomContent" | "classroomFocus" | "classroomExplanation" | "homework" | "assessmentFocus" | "correctionAdvice" | "otherNotes", value: string) {
    setLessonMaterial({ ...withoutLessonSummary(lessonMaterial), sessionCode, [key]: key === "lessonTitle" ? value : value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) });
  }
  function applyFeedbackScriptEntry(entry: { groupFeedback: string; topic: string; lessonNumber: number; perfectPrivateFeedback?: string; errorPrivateFeedback?: string }) {
    const parsed = parseLessonFeedbackMaterial(entry.groupFeedback, "", sessionCode);
    setGroupFeedbackRaw(entry.groupFeedback); setAssessmentBriefRaw("");
    setLessonMaterial({ ...parsed, lessonTitle: parsed.lessonTitle || entry.topic, scriptLessonNumber: entry.lessonNumber, perfectPrivateTemplate: entry.perfectPrivateFeedback, errorPrivateTemplate: entry.errorPrivateFeedback });
    setStatus(`已套用第 ${entry.lessonNumber} 课话术，可继续检查和整理。`);
  }
  function resetInputState(nextSessionCode = sessionCode) { setGroupFeedbackRaw(""); setAssessmentBriefRaw(""); setLessonMaterial(createEmptyLessonFeedbackMaterial(nextSessionCode)); assessmentPdfs.setItems([]); }
  function onSemesterChange(id: string) { setSemesterId(id); setClassName(""); setSessionCode(""); resetInputState(""); }
  function onClassChange(value: string) { setClassName(value); setSessionCode(""); resetInputState(""); }
  function onSessionChange(code: string) { setSessionCode(code); setDraftId(""); setParsedResult(null); setReviewResult(null); setCorrections([]); setConfirmed(false); resetInputState(code); workflow.reset(); setError(""); setStatus(""); }
  async function createSession() {
    if (!semesterId || !className) { setError("请先选择学期和班级"); return; }
    setCreatingSession(true); setError("");
    try {
      const data = await requestJson<{ code: string }>(`/api/semesters/${semesterId}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ className, date: newSessionDate }) });
      setSessionRefreshKey((value) => value + 1); onSessionChange(data.code); setStatus(`已新建 ${data.code}，可继续录入本节课的课堂回顾。`);
    } catch (reason) { setError(errorMessage(reason, "新建课次失败")); }
    finally { setCreatingSession(false); }
  }
  function resetDraftResult() { setStreamContent(""); setDraftId(""); setParsedResult(null); setReviewResult(null); setCorrections([]); setConfirmed(false); }
  function setParsedAttendance(index: number, present: boolean) { dispatchCore({ type: "parsed/attendance", index, present }); }
  function setParsedTeacherInterventions(index: number, interventions: TeacherIntervention[]) { dispatchCore({ type: "parsed/teacher-interventions", index, interventions }); }
  async function parse() {
    if (!rawText.trim()) { setError("请输入课后回顾"); return; }
    if (!sessionCode) { setError("请选择课次，未提及学生将按缺勤处理"); return; }
    setParsing(true); setError(""); resetDraftResult(); workflow.start("解析课堂回顾", "正在检查课次和课堂记录…"); workflow.transition("generating", "AI 正在提取学生表现、考勤和关键事件…");
    try {
      const response = await fetch("/api/input/parse?stream=true", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rawText, sessionCode }) });
      if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "解析失败");
      if ((response.headers.get("content-type") ?? "").includes("application/json")) {
        const data = await response.json() as { draftId: string; parsedResult: DraftStructuredResult; reviewResult: DraftReviewResult | null; corrections?: NameCorrection[]; warnings?: string[] };
        setDraftId(data.draftId);
        setParsedResult(data.parsedResult);
        setReviewResult(data.reviewResult);
        setCorrections(data.corrections ?? []);
        setParseStatus("STEP 文件解析完成");
        setStatus(data.warnings?.length ? data.warnings.join("；") : "STEP 文件解析完成，请确认结构化记录。");
        setActiveStep("review");
        workflow.transition("reviewing", "STEP 结构化草案已生成，请人工核对后再写入。");
        return;
      }
      if (!response.body) throw new Error("解析流不可用");
      await readSSEStream(response.body.getReader(), {
        parse: (value) => ParseStreamEventSchema.parse(value),
        onEvent: (message) => {
          if (message.type === "status") setParseStatus(message.message);
          else if (message.type === "chunk") dispatchCore({ type: "stream/append", content: message.content });
          else if (message.type === "result") { setDraftId(message.draftId); setParsedResult(message.parsedResult); setReviewResult(message.reviewResult); setCorrections(message.corrections ?? []); setParseStatus("解析完成"); setStatus("解析完成，请确认结构化记录。"); setActiveStep("review"); workflow.transition("reviewing", "结构化草案已生成，请人工核对后再写入。"); }
          else if (message.type === "error") throw new Error(message.message);
        },
      });
    } catch (reason) { const message = errorMessage(reason, "解析失败"); setError(message); workflow.fail(message, "generating"); }
    finally { setParsing(false); }
  }
  async function importAssistantRoster(files: FileList | null) {
    const selectedFiles = Array.from(files ?? []); if (!selectedFiles.length) return;
    if (!sessionCode) { setError("请先选择课次，再导入助教表"); return; }
    setAssistantImporting(true); setError(""); resetDraftResult(); workflow.start("解析助教表", "正在检查文件和课次…"); workflow.transition("generating", "正在把助教记录整理成结构化草案…");
    try {
      const formData = new FormData(); formData.set("sessionCode", sessionCode); selectedFiles.forEach((file) => formData.append("files", file));
      const data = await requestJson<{ rawText?: string; draftId: string; parsedResult: DraftStructuredResult; reviewResult: DraftReviewResult | null; corrections?: NameCorrection[]; warnings?: string[]; absentStudents?: string[]; matchedRows?: number }>("/api/feedback/assistant-roster", { method: "POST", body: formData });
      setRawText(data.rawText ?? ""); setDraftId(data.draftId); setParsedResult(data.parsedResult); setReviewResult(data.reviewResult); setCorrections(data.corrections ?? []); setParseStatus(`已从助教表生成课堂记录，匹配 ${data.matchedRows ?? 0} 条`); setStatus("助教表已解析，请确认结构化记录后写入。"); workflow.transition("reviewing", "助教表草案已生成，请人工核对后再写入。"); setActiveStep("review");
    } catch (reason) { const message = errorMessage(reason, "助教表解析失败"); setError(message); workflow.fail(message, "generating"); }
    finally { setAssistantImporting(false); }
  }
  async function importStepClassroom(file: File | undefined) {
    if (!file) return;
    if (!sessionCode) { setError("请先选择课次，再导入 STEP 课堂文本"); return; }
    setError("");
    try {
      const text = await file.text();
      if (!text.replace(/^\uFEFF/, "").trim().startsWith("STEP_CLASSROOM_EXPORT_V1")) {
        throw new Error("不是支持的 STEP 课堂导出文本");
      }
      setRawText(text);
      setParseStatus("已载入 STEP 课堂文本，请点击解析课堂回顾。");
      setStatus("STEP 文件已载入；解析前仍可检查目标课次。");
      setActiveStep("extract");
    } catch (reason) {
      setError(errorMessage(reason, "读取 STEP 课堂文本失败"));
    }
  }
  async function confirm() {
    if (!draftId) return;
    setConfirming(true); setError(""); workflow.start("写入结构化记录", "正在检查待写入草案…"); workflow.transition("saving", "正在写入评价、考勤和事件…");
    try {
      const data = await requestJson<{ warnings?: string[] }>("/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId, action: "confirm", edits: parsedResult }) });
      setConfirmed(true); setStatus(data.warnings?.length ? `课堂记录已写入；注意：${data.warnings.join("；")}` : "课堂记录已写入，下面可以制定总体反馈计划。"); setContextReloadKey((value) => value + 1); workflow.transition("completed", "结构化记录已经安全写入，反馈上下文已刷新。"); setActiveStep("review");
    } catch (reason) { const message = errorMessage(reason, "确认写入失败"); setError(message); workflow.fail(message, "saving"); }
    finally { setConfirming(false); }
  }
  function restoreLegacyDraft() {
    const legacyDraft = sessionStorage.getItem("student-track:nl-input-draft") ?? sessionStorage.getItem("chem-track:nl-input-draft");
    if (!legacyDraft) { setLegacyDraftAvailable(false); return; }
    setRawText(legacyDraft); sessionStorage.removeItem("student-track:nl-input-draft"); sessionStorage.removeItem("chem-track:nl-input-draft"); setLegacyDraftAvailable(false); setParseStatus("已载入课堂录入草稿。"); setActiveStep("extract");
  }
  const lessonMaterialNeedsOrganization = lessonMaterial.groupFeedbackRaw !== groupFeedbackRaw.trim() || lessonMaterial.assessmentBriefRaw !== assessmentBriefRaw.trim();
  return {
    activeStep, setActiveStep, context, contextHydrated, sessionRefreshKey, newSessionDate, setNewSessionDate, creatingSession,
    rawText, setRawText, parsing, assistantImporting, parseStatus, streamContent, draftId, parsedResult, reviewResult, corrections,
    confirming, confirmed, error, status, contextStudents, contextLoading, contextError, students,
    groupFeedbackRaw, assessmentBriefRaw, lessonMaterial, assessmentStudents, confirmedAssessmentEvidence,
    assessmentImports: assessmentPdfs.items, assessmentBatchBusy: assessmentPdfs.busy, assessmentFolderPlan: assessmentPdfs.folderPlan,
    assessmentConfirmedCount: assessmentPdfs.confirmedCount, assessmentReadyCount: assessmentPdfs.readyCount, assessmentAttentionCount: assessmentPdfs.attentionCount,
    lessonMaterialNeedsOrganization, updateGroupFeedbackRaw, updateAssessmentBriefRaw, organizeLessonMaterial, clearLessonMaterials, updateLessonMaterialSection, applyFeedbackScriptEntry,
    importAssessmentPdfs: assessmentPdfs.importPdfs, importAssessmentFolder: assessmentPdfs.importFolder, matchAssessmentItem: assessmentPdfs.matchItem, confirmAssessmentItem: assessmentPdfs.confirmItem,
    confirmAllAssessmentMatches: assessmentPdfs.confirmAllMatches, removeAssessmentItem: assessmentPdfs.removeItem, removeFailedAssessmentImports: assessmentPdfs.removeFailed, clearAssessmentImports: assessmentPdfs.clear,
    legacyDraftAvailable, restoreLegacyDraft, workflow: workflow.state, canParse: Boolean(rawText.trim() && sessionCode && !parsing), canConfirm: Boolean(draftId && parsedResult && !confirming),
    onSemesterChange, onClassChange, onSessionChange, createSession, setParsedAttendance, setParsedTeacherInterventions, parse, importAssistantRoster, importStepClassroom, confirm,
    setSemesterId, setClassName, setSessionCode,
  };
}
