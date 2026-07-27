"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FeedbackContextStudent } from "@/components/wecom/types";
import type { InputHistoryState } from "@/features/entry";
import { teachingContextWorkspaceKey, useTeachingContext } from "@/features/teaching-context";
import { useAiWorkflow } from "@/features/ai-workflow";
import { requestJson, requestJsonValidated } from "@/lib/api-client";
import {
  createEmptyLessonFeedbackMaterial,
  parseLessonFeedbackMaterial,
  type LessonFeedbackMaterial,
} from "@/lib/feedback-materials";
import { saveWorkHistory } from "@/lib/history";
import { readSSEStream } from "@/lib/sse";
import { ParseStreamEventSchema } from "@/lib/contracts/classroom-parse";
import {
  FeedbackBatchJsonResponseSchema,
  FeedbackBatchPostSchema,
  FeedbackBatchStreamEventSchema,
  FeedbackSingleResponseSchema,
} from "@/lib/contracts/feedback";
import type { DraftReviewResult, DraftStructuredResult, NameCorrection } from "@/lib/types";
import type { FeedbackReviewStatus } from "@/services/feedback-generation-service";
import type { FeedbackIntensity, FeedbackRoutingDecision } from "@/lib/feedback-intensity";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import type { FeedbackContextResponse, FeedbackHistoryState, FeedbackStep, FeedbackStudentOption, FeedbackWorkspaceState, SingleFeedbackHistoryState } from "./types";
import { isInputHistoryState } from "./history-adapters";
import { useAssessmentPdfImports } from "./useAssessmentPdfImports";
import { isFeedbackWorkspace, todayLocalDate } from "./workspace-state";
import {
  createFeedbackWorkspaceCoreState,
  feedbackCardsReducer,
  feedbackWorkspaceCoreReducer,
} from "./feedback-workspace-reducer";

function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

export function useFeedbackWorkspace(initialStep?: FeedbackStep) {
  const { context, hydrated: contextHydrated, setContext, setSemesterId, setClassName, setSessionCode } = useTeachingContext();
  const { semesterId, className, sessionCode } = context;
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const requestedStep = useRef<FeedbackStep | undefined>(initialStep);
  const [creatingSession, setCreatingSession] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [assistantImporting, setAssistantImporting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [generating, setGenerating] = useState(false);
  const generationAbortRef = useRef<AbortController | null>(null);
  const [regeneratingId, setRegeneratingId] = useState("");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [coreState, dispatchCore] = useReducer(
    feedbackWorkspaceCoreReducer,
    initialStep,
    (step) => ({
      ...createFeedbackWorkspaceCoreState(step ?? "prepare"),
      newSessionDate: todayLocalDate(),
    }),
  );
  const {
    activeStep,
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
    singleStudentId,
    singleDays,
    singleFeedback,
    singleDraftFeedback,
    singleReviewStatus,
    singleReviewIssues,
    groupFeedbackRaw,
    assessmentBriefRaw,
    lessonMaterial,
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
  const setSingleStudentId = (value: string) => patchCore({ singleStudentId: value });
  const setSingleDays = (value: number) => patchCore({ singleDays: value });
  const setSingleFeedback = (value: string) => patchCore({ singleFeedback: value });
  const setSingleDraftFeedback = (value: string) => patchCore({ singleDraftFeedback: value });
  const setSingleReviewStatus = (value: FeedbackReviewStatus | undefined) => patchCore({ singleReviewStatus: value });
  const setSingleReviewIssues = (value: string[]) => patchCore({ singleReviewIssues: value });
  const setGroupFeedbackRaw = (value: string) => patchCore({ groupFeedbackRaw: value });
  const setAssessmentBriefRaw = (value: string) => patchCore({ assessmentBriefRaw: value });
  const setLessonMaterial = (value: LessonFeedbackMaterial) => patchCore({ lessonMaterial: value });
  const [feedbackState, dispatchFeedback] = useReducer(feedbackCardsReducer, { cards: [], total: 0, done: 0, dirty: false, forceRegenerate: false });
  const { cards: feedbackCards, total: feedbackTotal, done: feedbackDone, dirty: feedbackDirty, forceRegenerate } = feedbackState;
  const [feedbackPhase, setFeedbackPhase] = useState<"idle" | "draft" | "review">("idle");
  const [contextStudents, setContextStudents] = useState<FeedbackContextStudent[]>([]);
  const [feedbackRouting, setFeedbackRouting] = useState<FeedbackRoutingDecision[]>([]);
  const [routingOverrides, setRoutingOverrides] = useState<Record<string, FeedbackIntensity>>({});
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [contextReloadKey, setContextReloadKey] = useState(0);
  const [students, setStudents] = useState<FeedbackStudentOption[]>([]);
  const [singleLoading, setSingleLoading] = useState(false);
  const [legacyDraftAvailable, setLegacyDraftAvailable] = useState(false);
  const workflow = useAiWorkflow();
  useEffect(() => () => generationAbortRef.current?.abort(), []);
  const assessmentStudents = useMemo<FeedbackStudentOption[]>(() => contextStudents.map((student) => ({
    id: student.id,
    name: student.name,
    studentId: student.studentId,
    class: className,
  })), [className, contextStudents]);
  const assessmentPdfs = useAssessmentPdfImports({
    sessionCode,
    students: assessmentStudents,
    onInputsChanged: () => markFeedbackInputsChanged(
      feedbackCards.length ? "出门测证据已改变，请重新生成反馈。" : "",
    ),
    setError,
    setStatus,
  });

  const workspaceValue = useMemo<FeedbackWorkspaceState>(() => ({
    activeStep, context, newSessionDate, rawText, parseStatus, streamContent, draftId, parsedResult,
    reviewResult, corrections, confirmed, status, feedbackCards, feedbackTotal, feedbackDone,
    feedbackDirty, forceRegenerate, singleStudentId, singleDays, singleFeedback,
    singleDraftFeedback, singleReviewStatus, singleReviewIssues, workflow: workflow.state,
    groupFeedbackRaw, assessmentBriefRaw, lessonMaterial, assessmentImports: assessmentPdfs.items, routingOverrides,
  }), [activeStep, context, newSessionDate, rawText, parseStatus, streamContent, draftId, parsedResult, reviewResult, corrections, confirmed, status, feedbackCards, feedbackTotal, feedbackDone, feedbackDirty, forceRegenerate, singleStudentId, singleDays, singleFeedback, singleDraftFeedback, singleReviewStatus, singleReviewIssues, workflow.state, groupFeedbackRaw, assessmentBriefRaw, lessonMaterial, assessmentPdfs.items, routingOverrides]);

  const workspace = useSessionWorkspace({
    key: teachingContextWorkspaceKey("feedback", context), value: workspaceValue,
    validate: isFeedbackWorkspace, enabled: contextHydrated,
    restore: (saved) => {
      const restoredStep = requestedStep.current ?? saved?.activeStep ?? (saved?.feedbackCards.length ? "export" : saved?.confirmed ? "generate" : saved?.parsedResult ? "review" : saved?.rawText ? "extract" : "prepare");
      requestedStep.current = undefined;
      setActiveStep(restoredStep);
      setNewSessionDate(saved?.newSessionDate ?? todayLocalDate());
      setRawText(saved?.rawText ?? ""); setParseStatus(saved?.parseStatus ?? ""); setStreamContent(saved?.streamContent ?? "");
      setDraftId(saved?.draftId ?? ""); setParsedResult(saved?.parsedResult ?? null); setReviewResult(saved?.reviewResult ?? null);
      setCorrections(saved?.corrections ?? []); setConfirmed(saved?.confirmed ?? false);
      dispatchFeedback({ type: "init", cards: saved?.feedbackCards ?? [], total: saved?.feedbackTotal ?? 0, done: saved?.feedbackDone ?? 0 });
      dispatchFeedback({ type: "dirty", value: saved?.feedbackDirty ?? false }); dispatchFeedback({ type: "force", value: saved?.forceRegenerate ?? false });
      setSingleStudentId(saved?.singleStudentId ?? ""); setSingleDays(saved?.singleDays ?? 14); setSingleFeedback(saved?.singleFeedback ?? "");
      setSingleDraftFeedback(saved?.singleDraftFeedback ?? ""); setSingleReviewStatus(saved?.singleReviewStatus); setSingleReviewIssues(saved?.singleReviewIssues ?? []);
      setGroupFeedbackRaw(saved?.groupFeedbackRaw ?? "");
      setAssessmentBriefRaw(saved?.assessmentBriefRaw ?? "");
      setLessonMaterial(saved?.lessonMaterial
        ? { ...saved.lessonMaterial, sessionCode: saved.context.sessionCode }
        : createEmptyLessonFeedbackMaterial(saved?.context.sessionCode));
      assessmentPdfs.setItems(saved?.assessmentImports ?? []);
      setRoutingOverrides(saved?.routingOverrides ?? {});
      workflow.restore(saved?.workflow);
      setStatus(saved ? saved.status || "已恢复上次离开时的页面内容。" : ""); setError("");
    },
  });

  const contextByStudent = useMemo(() => new Map(contextStudents.map((student) => [student.id, student])), [contextStudents]);
  const confirmedAssessmentEvidence = assessmentPdfs.evidenceByStudent;
  useEffect(() => { requestJson<FeedbackStudentOption[]>("/api/students").then(setStudents).catch(() => setStudents([])); }, []);
  useEffect(() => {
    if (!workspace.hydrated) return;
    const draft = sessionStorage.getItem("student-track:feedback-draft")
      ?? sessionStorage.getItem("chem-track:feedback-draft");
    const legacyDraft = sessionStorage.getItem("student-track:nl-input-draft")
      ?? sessionStorage.getItem("chem-track:nl-input-draft");
    if (draft) {
      dispatchCore({ type: "patch", patch: { rawText: draft, parseStatus: "已从录音转写载入课后回顾。" } }); sessionStorage.removeItem("student-track:feedback-draft"); sessionStorage.removeItem("chem-track:feedback-draft");
      setLegacyDraftAvailable(Boolean(legacyDraft));
    } else if (legacyDraft) {
      dispatchCore({ type: "patch", patch: { rawText: legacyDraft, parseStatus: "已载入旧课堂录入草稿。", activeStep: "extract" } }); sessionStorage.removeItem("student-track:nl-input-draft"); sessionStorage.removeItem("chem-track:nl-input-draft");
    }
  }, [workspace.hydrated]);
  useEffect(() => {
    if (!workspace.hydrated) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("step") === activeStep) return;
    url.searchParams.set("step", activeStep);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [activeStep, workspace.hydrated]);
  useEffect(() => {
    if (!sessionCode) { setContextStudents([]); setFeedbackRouting([]); setContextError(""); return; }
    let cancelled = false;
    setContextLoading(true); setContextError("");
    requestJson<FeedbackContextResponse>(`/api/report/feedback-context?sessionCode=${encodeURIComponent(sessionCode)}`)
      .then((data) => { if (!cancelled) { setContextStudents(data.students || []); setFeedbackRouting(data.routing || []); } })
      .catch((reason) => { if (!cancelled) { setContextStudents([]); setFeedbackRouting([]); setContextError(errorMessage(reason, "读取反馈上下文失败")); } })
      .finally(() => { if (!cancelled) setContextLoading(false); });
    return () => { cancelled = true; };
  }, [sessionCode, contextReloadKey]);

  function resetFeedback() { dispatchFeedback({ type: "reset" }); setFeedbackPhase("idle"); }
  function markFeedbackInputsChanged(message = "") {
    dispatchFeedback({ type: "force", value: true });
    if (feedbackCards.length > 0) dispatchFeedback({ type: "dirty", value: true });
    if (message) setStatus(message);
  }
  function effectiveLessonMaterial() {
    if (
      lessonMaterial.groupFeedbackRaw === groupFeedbackRaw.trim()
      && lessonMaterial.assessmentBriefRaw === assessmentBriefRaw.trim()
    ) return { ...lessonMaterial, sessionCode };
    return parseLessonFeedbackMaterial(groupFeedbackRaw, assessmentBriefRaw, sessionCode);
  }
  function feedbackSavePayload() {
    const payload = {
      sessionCode,
      historyModule: "feedback" as const,
      saveState: true,
      // 只提交持久化契约需要的字段；旧工作台缓存中的展示字段不会污染保存请求。
      students: feedbackCards.map((card) => ({
        id: card.id,
        name: card.name,
        labels: card.labels ?? [],
        feedback: card.feedback ?? "",
        ...(typeof card.draftFeedback === "string" ? { draftFeedback: card.draftFeedback } : {}),
        ...(card.reviewStatus ? { reviewStatus: card.reviewStatus } : {}),
        ...(Array.isArray(card.reviewIssues) ? { reviewIssues: card.reviewIssues } : {}),
      })),
      lessonMaterial: effectiveLessonMaterial(),
      assessmentEvidence: confirmedAssessmentEvidence,
      routingOverrides,
    };
    const parsed = FeedbackBatchPostSchema.safeParse(payload);
    if (parsed.success) return parsed.data;
    const fields = [...new Set(parsed.error.issues
      .map((issue) => issue.path.map(String).join("."))
      .filter(Boolean))]
      .slice(0, 5);
    throw new Error(fields.length
      ? `保存前检查发现资料不完整：${fields.join("、")}。请重新确认对应材料后再试。`
      : "保存前检查发现反馈资料不完整，请重新确认后再试。");
  }
  function updateGroupFeedbackRaw(value: string) {
    setGroupFeedbackRaw(value);
    markFeedbackInputsChanged(feedbackCards.length ? "课程材料已改变，请重新生成反馈。" : "");
  }
  function updateAssessmentBriefRaw(value: string) {
    setAssessmentBriefRaw(value);
    markFeedbackInputsChanged(feedbackCards.length ? "测验说明已改变，请重新生成反馈。" : "");
  }
  function organizeLessonMaterial() {
    const parsed = parseLessonFeedbackMaterial(groupFeedbackRaw, assessmentBriefRaw, sessionCode);
    setLessonMaterial(parsed);
    markFeedbackInputsChanged(feedbackCards.length ? "课程材料已重新整理，请重新生成反馈。" : "课程材料已整理，可在下方检查。");
  }
  function clearLessonMaterials() {
    setGroupFeedbackRaw("");
    setAssessmentBriefRaw("");
    setLessonMaterial(createEmptyLessonFeedbackMaterial(sessionCode));
    markFeedbackInputsChanged(feedbackCards.length ? "课程材料已清空，请重新生成反馈。" : "课程材料已清空。");
  }
  function updateLessonMaterialSection(
    key: "lessonTitle" | "classroomContent" | "classroomFocus" | "classroomExplanation" | "homework" | "assessmentFocus" | "correctionAdvice" | "otherNotes",
    value: string,
  ) {
    setLessonMaterial({
      ...lessonMaterial,
      sessionCode,
      [key]: key === "lessonTitle"
        ? value
        : value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    });
    markFeedbackInputsChanged(feedbackCards.length ? "整理后的课程材料已修改，请重新生成反馈。" : "");
  }
  function resetFeedbackInputs(nextSessionCode = sessionCode) {
    setGroupFeedbackRaw("");
    setAssessmentBriefRaw("");
    setLessonMaterial(createEmptyLessonFeedbackMaterial(nextSessionCode));
    assessmentPdfs.setItems([]);
  }
  function onSemesterChange(id: string) { setSemesterId(id); setClassName(""); setSessionCode(""); setRoutingOverrides({}); resetFeedback(); }
  function onClassChange(value: string) { setClassName(value); setSessionCode(""); setRoutingOverrides({}); resetFeedback(); }
  function onSessionChange(code: string) {
    setSessionCode(code); setDraftId(""); setParsedResult(null); setReviewResult(null); setCorrections([]); setConfirmed(false);
    setRoutingOverrides({}); resetFeedback(); resetFeedbackInputs(code); workflow.reset(); setError(""); setStatus("");
  }
  async function createSession() {
    if (!semesterId || !className) { setError("请先选择学期和班级"); return; }
    setCreatingSession(true); setError(""); setStatus("");
    try {
      const data = await requestJson<{ code: string }>(`/api/semesters/${semesterId}/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ className, date: newSessionDate }) });
      setSessionRefreshKey((current) => current + 1); onSessionChange(data.code); setStatus(`已新建 ${data.code}，可继续录入本节课的课堂回顾。`);
    } catch (reason) { setError(errorMessage(reason, "新建课次失败")); }
    finally { setCreatingSession(false); }
  }
  function setParsedAttendance(index: number, present: boolean) {
    dispatchCore({ type: "parsed/attendance", index, present });
  }
  function resetDraftResult() { setStreamContent(""); setDraftId(""); setParsedResult(null); setReviewResult(null); setCorrections([]); setConfirmed(false); }
  async function parse() {
    if (!rawText.trim()) { setError("请输入课后回顾"); return; }
    if (!sessionCode) { setError("请选择课次，未提及学生将按缺勤处理"); return; }
    setParsing(true); setError(""); setStatus(""); resetDraftResult();
    workflow.start("解析课堂回顾", "正在检查课次和课堂记录…");
    workflow.transition("generating", "AI 正在提取学生表现、考勤和关键事件…");
    try {
      const response = await fetch("/api/input/parse?stream=true", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rawText, sessionCode }) });
      if (!response.ok) throw new Error((await response.json()).error);
      if (!response.body) throw new Error("解析流不可用");
      await readSSEStream(response.body.getReader(), {
        parse: (value) => ParseStreamEventSchema.parse(value),
        onEvent: (message) => {
        if (message.type === "status") setParseStatus(message.message);
        else if (message.type === "chunk") dispatchCore({ type: "stream/append", content: message.content });
        else if (message.type === "result") { const warningText = message.warnings?.length ? `；注意：${message.warnings.join("；")}` : ""; setDraftId(message.draftId); setParsedResult(message.parsedResult); setReviewResult(message.reviewResult); setCorrections(message.corrections || []); setParseStatus(warningText ? `解析完成${warningText}` : "解析完成"); setStatus(`解析完成，请确认结构化记录${warningText}。`); setActiveStep("review"); workflow.transition("reviewing", "结构化草案已生成，请人工核对后再写入。"); }
        else if (message.type === "error") throw new Error(message.message);
        },
      });
    } catch (reason) { const message = errorMessage(reason, "解析失败"); setError(message); workflow.fail(message, "generating"); }
    finally { setParsing(false); }
  }
  async function importAssistantRoster(files: FileList | null) {
    const selectedFiles = Array.from(files || []); if (!selectedFiles.length) return;
    if (!sessionCode) { setError("请先选择课次，再导入助教表"); return; }
    setAssistantImporting(true); setError(""); setStatus(""); resetDraftResult();
    workflow.start("解析助教表", "正在检查文件和课次…");
    workflow.transition("generating", "正在把助教记录整理成结构化草案…");
    try {
      const formData = new FormData(); formData.set("sessionCode", sessionCode); selectedFiles.forEach((file) => formData.append("files", file));
      const data = await requestJson<{ rawText?: string; draftId: string; parsedResult: DraftStructuredResult; reviewResult: DraftReviewResult | null; corrections?: NameCorrection[]; warnings?: string[]; absentStudents?: string[]; matchedRows?: number }>("/api/feedback/assistant-roster", { method: "POST", body: formData });
      setRawText(data.rawText || ""); setDraftId(data.draftId); setParsedResult(data.parsedResult); setReviewResult(data.reviewResult); setCorrections(data.corrections || []);
      const warningText = data.warnings?.length ? `；注意：${data.warnings.join("；")}` : ""; const absentText = data.absentStudents?.length ? `；缺勤：${data.absentStudents.join("、")}` : "";
      setParseStatus(`已从助教表生成课堂记录，匹配 ${data.matchedRows ?? 0} 条${absentText}${warningText}`); setStatus("助教表已解析，请确认结构化记录后写入。");
      workflow.transition("reviewing", "助教表草案已生成，请人工核对后再写入。");
      setActiveStep("review");
    } catch (reason) { const message = errorMessage(reason, "助教表解析失败"); setError(message); workflow.fail(message, "generating"); }
    finally { setAssistantImporting(false); }
  }
  async function confirm() {
    if (!draftId) return; setConfirming(true); setError(""); setStatus("");
    workflow.start("写入结构化记录", "正在检查待写入草案…");
    workflow.transition("saving", "正在写入评价、考勤和事件…");
    try {
      const data = await requestJson<{ warnings?: string[] }>("/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId, action: "confirm", edits: parsedResult }) });
      setConfirmed(true); setStatus(data.warnings?.length ? `课堂记录已写入；注意：${data.warnings.join("；")}` : "课堂记录已写入，反馈上下文已刷新。");
      setContextReloadKey((current) => current + 1); dispatchFeedback({ type: "reset", forceRegenerate: true });
      workflow.transition("completed", "结构化记录已经安全写入，反馈上下文已刷新。");
      setActiveStep("generate");
    } catch (reason) { const message = errorMessage(reason, "确认写入失败"); setError(message); workflow.fail(message, "saving"); }
    finally { setConfirming(false); }
  }
  async function generate() {
    if (!sessionCode) { setError("请先选择课次"); return; }
    generationAbortRef.current?.abort();
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setGenerating(true); setError(""); setStatus(""); dispatchFeedback({ type: "reset" }); setFeedbackPhase("draft");
    workflow.start("生成课后反馈", "正在检查课次和反馈上下文…");
    workflow.transition("generating", "正在按本次反馈强度生成家长话术…");
    try {
      const response = await fetch("/api/report/feedback-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sessionCode,
          historyModule: "feedback",
          bypassCache: forceRegenerate,
          lessonMaterial: effectiveLessonMaterial(),
          assessmentEvidence: confirmedAssessmentEvidence,
          routingOverrides,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      if ((response.headers.get("content-type") || "").includes("application/json")) {
        const data = FeedbackBatchJsonResponseSchema.parse(await response.json()); dispatchFeedback({ type: "init", cards: data.students || [], total: data.total, done: data.total }); setFeedbackPhase("idle"); setStatus(data.cached ? "已恢复最近一次生成结果。" : "已按本次反馈强度生成家长话术，请逐条检查后再导出。"); dispatchFeedback({ type: "force", value: false }); setActiveStep("export"); workflow.transition("reviewing", "家长话术已生成，请处理待人工确认项。"); return;
      }
      if (!response.body) throw new Error("生成流不可用");
      let streamTotal = 0;
      await readSSEStream(response.body.getReader(), {
        signal: controller.signal,
        parse: (value) => FeedbackBatchStreamEventSchema.parse(value),
        onEvent: (message) => {
        if (message.type === "init") { streamTotal = message.total; dispatchFeedback({ type: "init", cards: message.students, total: message.total }); setFeedbackPhase("draft"); workflow.progress(0, `准备生成 ${message.total} 名学生的反馈…`); }
        else if (message.type === "draft") { const completed = Number(message.completed || 0); setFeedbackPhase("draft"); dispatchFeedback({ type: "progress", done: completed }); workflow.progress(streamTotal ? completed / (streamTotal * 2) : 0, `生成 ${completed}/${streamTotal}`); dispatchFeedback({ type: "patch", studentId: message.studentId, patch: { feedback: message.feedback, draftFeedback: message.draftFeedback, reviewStatus: message.reviewStatus, reviewIssues: message.reviewIssues || [] } }); }
        else if (message.type === "review") { const completed = Number(message.completed || 0); setFeedbackPhase("review"); dispatchFeedback({ type: "progress", done: completed }); workflow.progress(streamTotal ? (streamTotal + completed) / (streamTotal * 2) : 0, `成稿与审核 ${completed}/${streamTotal}`); dispatchFeedback({ type: "patch", studentId: message.studentId, patch: { feedback: message.feedback, draftFeedback: message.draftFeedback, reviewStatus: message.reviewStatus, reviewIssues: message.reviewIssues || [] } }); }
        else if (message.type === "done") { dispatchFeedback({ type: "init", cards: message.students || [], total: message.total, done: message.total }); setFeedbackPhase("idle"); setStatus("已按本次反馈强度生成家长话术，请逐条检查后再导出。"); dispatchFeedback({ type: "force", value: false }); setActiveStep("export"); workflow.transition("reviewing", "家长话术已生成，请处理待人工确认项。"); }
        else if (message.type === "error") throw new Error(message.message || "批量生成失败");
        },
      });
    } catch (reason) {
      if (controller.signal.aborted) {
        setError("");
        setStatus("已取消本次反馈生成；未完成的结果不会保存。");
        workflow.cancel("本次反馈生成已由教师取消。");
      } else {
        const message = errorMessage(reason, "批量生成失败");
        setError(message);
        workflow.fail(message, "generating");
      }
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = null;
      setGenerating(false);
      setFeedbackPhase("idle");
    }
  }
  function cancelGeneration() {
    if (!generationAbortRef.current) return;
    setStatus("正在取消本次反馈生成…");
    generationAbortRef.current.abort();
  }
  function prepareRegeneration() {
    dispatchFeedback({ type: "reset", forceRegenerate: true }); setFeedbackPhase("idle"); setError("");
    setStatus("旧批次已从当前工作区移除；下一次生成将使用当前模型重新处理。");
    workflow.reset(); setActiveStep("generate");
  }
  async function regenerateOne(studentId: string) {
    if (!sessionCode || !feedbackCards.some((card) => card.id === studentId)) return;
    setRegeneratingId(studentId); setError("");
    try { const card = feedbackCards.find((item) => item.id === studentId); const data = await requestJsonValidated(FeedbackSingleResponseSchema, "/api/report/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studentId, sessionCode, lessonMaterial: effectiveLessonMaterial(), assessmentEvidence: confirmedAssessmentEvidence[studentId], feedbackIntensity: card?.feedbackIntensity }) }); dispatchFeedback({ type: "patch", studentId, patch: { feedback: data.feedback || "", draftFeedback: data.draftFeedback, reviewStatus: data.reviewStatus, reviewIssues: data.reviewIssues || [] } }); dispatchFeedback({ type: "dirty", value: true }); }
    catch (reason) { setError(errorMessage(reason, "重新生成失败")); }
    finally { setRegeneratingId(""); }
  }
  function updateFeedback(studentId: string, feedback: string) { dispatchFeedback({ type: "patch", studentId, patch: { feedback, reviewStatus: "edited", reviewIssues: ["教师已人工修改，导出以当前文本为准"] } }); dispatchFeedback({ type: "dirty", value: true }); }
  function setFeedbackIntensity(studentId: string, intensity: FeedbackIntensity | "automatic") {
    setRoutingOverrides((current) => {
      if (intensity === "automatic") {
        const { [studentId]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [studentId]: intensity };
    });
    markFeedbackInputsChanged(feedbackCards.length ? "反馈档位已改变，请重新生成反馈。" : "反馈档位已调整。");
  }
  async function saveFeedbackState() { if (!sessionCode || !feedbackCards.length) return; await requestJson("/api/report/feedback-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(feedbackSavePayload()) }); dispatchFeedback({ type: "dirty", value: false }); }
  async function exportFeedback() {
    if (!sessionCode || !feedbackCards.length) return;
    const blockerCount = feedbackCards.filter((card) => card.reviewStatus === "needs_review").length;
    if (blockerCount > 0) {
      setError(`还有 ${blockerCount} 条反馈需要人工确认；请修改或重新生成后再导出。`);
      return;
    }
    setExporting(true); setError("");
    workflow.start("保存并导出反馈", "正在检查最终反馈文本…"); workflow.transition("saving", "正在保存修改并准备 Excel…");
    try { if (feedbackDirty) await saveFeedbackState(); const anchor = document.createElement("a"); anchor.href = `/api/report/feedback-batch?sessionCode=${sessionCode}&module=feedback`; anchor.download = `feedback_${sessionCode}.xlsx`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setStatus("已准备导出文件。"); workflow.transition("completed", "最终反馈已保存，导出文件已准备完成。"); }
    catch (reason) { const message = errorMessage(reason, "导出失败"); setError(message); workflow.fail(message, "saving"); }
    finally { setExporting(false); }
  }
  function restoreHistory(state: FeedbackHistoryState | InputHistoryState) {
    if (isInputHistoryState(state)) {
      setContext({ semesterId: state.semesterId, className: state.className, sessionCode: state.sessionCode });
      setRawText(state.rawText); setDraftId(state.result.draftId); setParsedResult(state.result.parsedResult);
      setReviewResult(state.result.reviewResult); setCorrections(state.result.corrections || []); setConfirmed(false);
      setActiveStep("review"); setError(""); setStatus("已恢复旧课堂录入历史，请核对后确认写入。");
      workflow.start("恢复课堂录入草案", "正在准备旧课堂录入草案…");
      workflow.transition("reviewing", "旧课堂录入草案已恢复，请人工核对。");
      return;
    }
    if (state.kind === "single") { setContext({ semesterId: state.semesterId, className: state.className, sessionCode: state.sessionCode }); setSingleStudentId(state.studentId); setSingleDays(state.days); setSingleFeedback(state.feedback); setSingleDraftFeedback(state.draftFeedback ?? ""); setSingleReviewStatus(state.reviewStatus); setSingleReviewIssues(state.reviewIssues ?? []); setError(""); setStatus("已恢复单人反馈历史。"); return; }
    setContext({ semesterId: state.semesterId, className: state.className, sessionCode: state.sessionCode });
    dispatchFeedback({ type: "init", cards: state.students, total: state.total, done: state.total }); setRoutingOverrides(state.routingOverrides ?? {}); dispatchFeedback({ type: "force", value: false });
    if (state.lessonMaterial) {
      setLessonMaterial({ ...state.lessonMaterial, sessionCode: state.sessionCode });
      setGroupFeedbackRaw(state.lessonMaterial.groupFeedbackRaw);
      setAssessmentBriefRaw(state.lessonMaterial.assessmentBriefRaw);
    } else {
      setLessonMaterial(createEmptyLessonFeedbackMaterial(state.sessionCode));
      setGroupFeedbackRaw("");
      setAssessmentBriefRaw("");
    }
    if (state.assessmentEvidence) {
      assessmentPdfs.setItems(Object.entries(state.assessmentEvidence).map(([studentId, evidence], index) => {
        const card = state.students.find((item) => item.id === studentId);
        return {
          id: `history-${studentId}-${index}`,
          fileName: "历史出门测证据",
          status: "confirmed",
          reportStudentName: card?.name ?? "",
          reportStudentId: "",
          matchedStudentId: studentId,
          matchedStudentName: card?.name ?? "",
          evidence: { ...evidence, sessionCode: state.sessionCode, studentId },
          error: "",
        };
      }));
    } else {
      assessmentPdfs.setItems([]);
    }
    setActiveStep("export"); setContextReloadKey((current) => current + 1); setError(""); setStatus("已恢复历史反馈结果。");
  }
  function restoreLegacyDraft() {
    const legacyDraft = sessionStorage.getItem("student-track:nl-input-draft")
      ?? sessionStorage.getItem("chem-track:nl-input-draft");
    if (!legacyDraft) { setLegacyDraftAvailable(false); return; }
    if (rawText.trim()) sessionStorage.setItem("student-track:feedback-draft", rawText);
    setRawText(legacyDraft); sessionStorage.removeItem("student-track:nl-input-draft"); sessionStorage.removeItem("chem-track:nl-input-draft"); setLegacyDraftAvailable(false);
    setParseStatus("已载入旧课堂录入草稿；原工作台内容已保留为反馈草稿。"); setActiveStep("extract");
  }
  async function generateSingleFeedback() {
    if (!singleStudentId) return; setSingleLoading(true); setError("");
    try {
      const body = sessionCode
        ? { studentId: singleStudentId, sessionCode, lessonMaterial: effectiveLessonMaterial(), assessmentEvidence: confirmedAssessmentEvidence[singleStudentId] }
        : { studentId: singleStudentId, days: singleDays };
      const data = await requestJsonValidated(FeedbackSingleResponseSchema, "/api/report/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const feedback = data.feedback ?? ""; setSingleFeedback(feedback); setSingleDraftFeedback(data.draftFeedback ?? ""); setSingleReviewStatus(data.reviewStatus); setSingleReviewIssues(data.reviewIssues ?? []);
      await saveWorkHistory("feedback", `学生反馈 ${sessionCode || `近${singleDays}天`}`, { kind: "single", semesterId, className, studentId: singleStudentId, sessionCode, days: singleDays, feedback, draftFeedback: data.draftFeedback, reviewStatus: data.reviewStatus, reviewIssues: data.reviewIssues } satisfies SingleFeedbackHistoryState, sessionCode || singleStudentId);
    } catch (reason) { setError(errorMessage(reason, "生成单人反馈失败")); }
    finally { setSingleLoading(false); }
  }

  function updateSingleFeedback(value: string) {
    setSingleFeedback(value);
    setSingleReviewStatus("edited");
    setSingleReviewIssues(["教师已人工修改，当前文本可直接使用"]);
  }

  const feedbackReviewBlockerCount = feedbackCards.filter((card) => card.reviewStatus === "needs_review").length;
  const lessonMaterialNeedsOrganization = (
    lessonMaterial.groupFeedbackRaw !== groupFeedbackRaw.trim()
    || lessonMaterial.assessmentBriefRaw !== assessmentBriefRaw.trim()
  );

  return {
    activeStep, setActiveStep, context, contextHydrated, sessionRefreshKey, newSessionDate, setNewSessionDate, creatingSession, rawText, setRawText,
    parsing, assistantImporting, parseStatus, streamContent, draftId, parsedResult, reviewResult, corrections, confirming, confirmed,
    generating, regeneratingId, exporting, error, status, feedbackCards, feedbackTotal, feedbackDone, feedbackPhase, feedbackReviewBlockerCount, contextStudents, contextLoading,
    contextError, feedbackDirty, students, singleStudentId, setSingleStudentId, singleDays, setSingleDays, singleFeedback, singleDraftFeedback, singleReviewStatus, singleReviewIssues, updateSingleFeedback,
    groupFeedbackRaw, assessmentBriefRaw, lessonMaterial,
    assessmentImports: assessmentPdfs.items, assessmentBatchBusy: assessmentPdfs.busy,
    assessmentFolderPlan: assessmentPdfs.folderPlan, assessmentStudents,
    confirmedAssessmentEvidence, feedbackRouting, routingOverrides,
    assessmentConfirmedCount: assessmentPdfs.confirmedCount,
    assessmentReadyCount: assessmentPdfs.readyCount,
    assessmentAttentionCount: assessmentPdfs.attentionCount,
    lessonMaterialNeedsOrganization,
    updateGroupFeedbackRaw, updateAssessmentBriefRaw, organizeLessonMaterial, clearLessonMaterials, updateLessonMaterialSection,
    importAssessmentPdfs: assessmentPdfs.importPdfs,
    importAssessmentFolder: assessmentPdfs.importFolder,
    matchAssessmentItem: assessmentPdfs.matchItem,
    confirmAssessmentItem: assessmentPdfs.confirmItem,
    confirmAllAssessmentMatches: assessmentPdfs.confirmAllMatches,
    removeAssessmentItem: assessmentPdfs.removeItem,
    removeFailedAssessmentImports: assessmentPdfs.removeFailed,
    clearAssessmentImports: assessmentPdfs.clear,
    legacyDraftAvailable, restoreLegacyDraft,
    singleLoading, contextByStudent, workflow: workflow.state, canParse: Boolean(rawText.trim() && sessionCode && !parsing), canConfirm: Boolean(draftId && parsedResult && !confirming), canGenerate: Boolean(sessionCode && !generating),
    onSemesterChange, onClassChange, onSessionChange, createSession, setParsedAttendance, parse, importAssistantRoster, confirm, generate, cancelGeneration, prepareRegeneration,
    regenerateOne, updateFeedback, setFeedbackIntensity, exportFeedback, restoreHistory, generateSingleFeedback,
  };
}
