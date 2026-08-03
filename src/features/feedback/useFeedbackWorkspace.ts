"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FeedbackContextStudent } from "@/features/feedback/context-types";
import type { InputHistoryState } from "@/features/entry";
import { teachingContextWorkspaceKey } from "@/features/teaching-context/url-context";
import { useTeachingContext } from "@/features/teaching-context/use-teaching-context";
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
import type { DraftReviewResult, DraftStructuredResult, NameCorrection, TeacherIntervention } from "@/lib/types";
import type { FeedbackReviewStatus } from "@/services/feedback-generation-service";
import type { FeedbackIntensity, FeedbackRoutingDecision } from "@/lib/feedback-intensity";
import type { FeedbackScriptEntry } from "@/lib/feedback-script-library";
import { DEFAULT_FEEDBACK_OUTPUT_STRATEGY, isLegacyLengthOnlyReview, normalizeFeedbackOutputStrategy, type FeedbackOutputStrategy } from "@/lib/feedback-sections";
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
import {
  emptyFeedbackBatchProgress,
  feedbackBatchCanExport,
  remainingFeedbackStudentIds,
  restoreFeedbackBatchProgress,
  updateStudentProgress,
} from "./feedback-batch-progress";

function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

export interface FeedbackVersionSummary {
  id: string;
  studentId: string | null;
  parentGenerationId: string | null;
  modelProfileId: string | null;
  modelProfileName: string | null;
  modelName: string;
  generatedAt: string;
  selected: boolean;
  finalText: string;
  reviewStatus: FeedbackReviewStatus | null;
  replayable: boolean;
  stale: boolean;
  replayState: string;
}

export interface FeedbackVersionProfile {
  id: string;
  name: string;
  model: string;
}

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
  const [feedbackBatch, setFeedbackBatch] = useState(emptyFeedbackBatchProgress);
  const [feedbackPhase, setFeedbackPhase] = useState<"idle" | "draft" | "review">("idle");
  const [contextStudents, setContextStudents] = useState<FeedbackContextStudent[]>([]);
  const [feedbackRouting, setFeedbackRouting] = useState<FeedbackRoutingDecision[]>([]);
  const [routingOverrides, setRoutingOverrides] = useState<Record<string, FeedbackIntensity>>({});
  const [outputStrategy, setOutputStrategyState] = useState<FeedbackOutputStrategy>(DEFAULT_FEEDBACK_OUTPUT_STRATEGY);
  const [feedbackVersions, setFeedbackVersions] = useState<FeedbackVersionSummary[]>([]);
  const [feedbackVersionProfiles, setFeedbackVersionProfiles] = useState<FeedbackVersionProfile[]>([]);
  const [feedbackVersionProfileId, setFeedbackVersionProfileId] = useState("");
  const [feedbackVersionBusyId, setFeedbackVersionBusyId] = useState("");
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

  async function refreshFeedbackVersions() {
    if (!sessionCode) {
      setFeedbackVersions([]);
      return;
    }
    const [versionsResult, profilesResult] = await Promise.all([
      requestJson<{ versions: FeedbackVersionSummary[] }>(`/api/report/feedback-versions?sessionCode=${encodeURIComponent(sessionCode)}`),
      requestJson<{ profiles: FeedbackVersionProfile[] }>("/api/report/feedback-versions/profiles"),
    ]);
    setFeedbackVersions(versionsResult.versions);
    setFeedbackVersionProfiles(profilesResult.profiles);
    setFeedbackVersionProfileId((current) => (
      profilesResult.profiles.some((profile) => profile.id === current)
        ? current
        : profilesResult.profiles[0]?.id ?? ""
    ));
  }

  useEffect(() => {
    if (!sessionCode || feedbackBatch.status !== "completed") return;
    void refreshFeedbackVersions().catch(() => undefined);
  // Refresh once when a completed batch/revision becomes current.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCode, feedbackBatch.status, feedbackBatch.inputRevision]);

  const workspaceValue = useMemo<FeedbackWorkspaceState>(() => ({
    activeStep, context, newSessionDate, rawText, parseStatus, streamContent, draftId, parsedResult,
    reviewResult, corrections, confirmed, status, feedbackCards, feedbackTotal, feedbackDone,
    feedbackDirty, forceRegenerate, feedbackBatch, singleStudentId, singleDays, singleFeedback,
    singleDraftFeedback, singleReviewStatus, singleReviewIssues, workflow: workflow.state,
    groupFeedbackRaw, assessmentBriefRaw, lessonMaterial, assessmentImports: assessmentPdfs.items, routingOverrides, outputStrategy,
  }), [activeStep, context, newSessionDate, rawText, parseStatus, streamContent, draftId, parsedResult, reviewResult, corrections, confirmed, status, feedbackCards, feedbackTotal, feedbackDone, feedbackDirty, forceRegenerate, feedbackBatch, singleStudentId, singleDays, singleFeedback, singleDraftFeedback, singleReviewStatus, singleReviewIssues, workflow.state, groupFeedbackRaw, assessmentBriefRaw, lessonMaterial, assessmentPdfs.items, routingOverrides, outputStrategy]);

  const workspace = useSessionWorkspace({
    key: teachingContextWorkspaceKey("feedback", context), value: workspaceValue,
    validate: isFeedbackWorkspace, enabled: contextHydrated,
    restore: (saved) => {
      const restoredBatch = restoreFeedbackBatchProgress({
        saved: saved?.feedbackBatch,
        cards: saved?.feedbackCards ?? [],
        total: saved?.feedbackTotal ?? 0,
        legacyDone: saved?.feedbackDone ?? 0,
      });
      const interrupted = restoredBatch.status === "incomplete" || restoredBatch.status === "stale";
      const restoredStep = (interrupted && saved?.feedbackCards.length ? "export" : requestedStep.current)
        ?? saved?.activeStep
        ?? (saved?.feedbackCards.length ? "export" : saved?.confirmed ? "generate" : saved?.parsedResult ? "review" : saved?.rawText ? "extract" : "prepare");
      requestedStep.current = undefined;
      setActiveStep(restoredStep);
      setNewSessionDate(saved?.newSessionDate ?? todayLocalDate());
      setRawText(saved?.rawText ?? ""); setParseStatus(saved?.parseStatus ?? ""); setStreamContent(saved?.streamContent ?? "");
      setDraftId(saved?.draftId ?? ""); setParsedResult(saved?.parsedResult ?? null); setReviewResult(saved?.reviewResult ?? null);
      setCorrections(saved?.corrections ?? []); setConfirmed(saved?.confirmed ?? false);
      dispatchFeedback({ type: "init", cards: saved?.feedbackCards ?? [], total: saved?.feedbackTotal ?? 0, done: saved?.feedbackDone ?? 0 });
      dispatchFeedback({ type: "dirty", value: saved?.feedbackDirty ?? false }); dispatchFeedback({ type: "force", value: saved?.forceRegenerate ?? false });
      setFeedbackBatch(restoredBatch);
      setSingleStudentId(saved?.singleStudentId ?? ""); setSingleDays(saved?.singleDays ?? 14); setSingleFeedback(saved?.singleFeedback ?? "");
      setSingleDraftFeedback(saved?.singleDraftFeedback ?? ""); setSingleReviewStatus(saved?.singleReviewStatus); setSingleReviewIssues(saved?.singleReviewIssues ?? []);
      setGroupFeedbackRaw(saved?.groupFeedbackRaw ?? "");
      setAssessmentBriefRaw(saved?.assessmentBriefRaw ?? "");
      setLessonMaterial(saved?.lessonMaterial
        ? { ...saved.lessonMaterial, sessionCode: saved.context.sessionCode }
        : createEmptyLessonFeedbackMaterial(saved?.context.sessionCode));
      assessmentPdfs.setItems(saved?.assessmentImports ?? []);
      setRoutingOverrides(saved?.routingOverrides ?? {});
      setOutputStrategyState(normalizeFeedbackOutputStrategy(saved?.outputStrategy));
      workflow.restore(saved?.workflow);
      setStatus(saved
        ? interrupted
          ? `批次未完成：已恢复 ${restoredBatch.completedStudentIds.length}/${restoredBatch.total} 名学生的可用结果。`
          : saved.status || "已恢复上次离开时的页面内容。"
        : "");
      setError("");
    },
  });

  const contextByStudent = useMemo(() => new Map(contextStudents.map((student) => [student.id, student])), [contextStudents]);
  const confirmedAssessmentEvidence = assessmentPdfs.evidenceByStudent;
  useEffect(() => {
    if (!contextHydrated || !semesterId) {
      setStudents([]);
      return;
    }
    const query = new URLSearchParams({ scope: "active", semesterId });
    requestJson<FeedbackStudentOption[]>(`/api/students?${query.toString()}`)
      .then(setStudents)
      .catch(() => setStudents([]));
  }, [contextHydrated, semesterId]);
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
    requestJson<FeedbackContextResponse>(`/api/report/feedback-context?sessionCode=${encodeURIComponent(sessionCode)}&semesterId=${encodeURIComponent(semesterId)}`)
      .then((data) => { if (!cancelled) { setContextStudents(data.students || []); setFeedbackRouting(data.routing || []); } })
      .catch((reason) => { if (!cancelled) { setContextStudents([]); setFeedbackRouting([]); setContextError(errorMessage(reason, "读取反馈上下文失败")); } })
      .finally(() => { if (!cancelled) setContextLoading(false); });
    return () => { cancelled = true; };
  }, [semesterId, sessionCode, contextReloadKey]);

  function resetFeedback() { dispatchFeedback({ type: "reset" }); setFeedbackBatch(emptyFeedbackBatchProgress()); setFeedbackPhase("idle"); }
  function markFeedbackInputsChanged(message = "") {
    dispatchFeedback({ type: "force", value: true });
    if (feedbackCards.length > 0) {
      dispatchFeedback({ type: "dirty", value: true });
      setFeedbackBatch((current) => ({
        ...current,
        status: "stale",
        interruptionReason: "输入材料、证据、反馈档位或输出策略已经变化",
      }));
    }
    if (message) setStatus(message);
  }
  function effectiveLessonMaterial() {
    if (
      lessonMaterial.groupFeedbackRaw === groupFeedbackRaw.trim()
      && lessonMaterial.assessmentBriefRaw === assessmentBriefRaw.trim()
    ) return { ...lessonMaterial, sessionCode };
    return {
      ...parseLessonFeedbackMaterial(groupFeedbackRaw, assessmentBriefRaw, sessionCode),
      scriptLessonNumber: lessonMaterial.scriptLessonNumber,
      perfectPrivateTemplate: lessonMaterial.perfectPrivateTemplate,
      errorPrivateTemplate: lessonMaterial.errorPrivateTemplate,
    };
  }
  function withoutLessonSummary(material: LessonFeedbackMaterial): LessonFeedbackMaterial {
    const {
      lessonSummary: _lessonSummary,
      lessonSummarySourceHash: _lessonSummarySourceHash,
      lessonSummaryStatus: _lessonSummaryStatus,
      ...source
    } = material;
    void _lessonSummary;
    void _lessonSummarySourceHash;
    void _lessonSummaryStatus;
    return source;
  }
  function adoptLessonMaterial(material?: LessonFeedbackMaterial) {
    if (material) setLessonMaterial({ ...material, sessionCode });
  }
  function feedbackSavePayload(partial = false) {
    const payload = {
      sessionCode,
      semesterId,
      historyModule: "feedback" as const,
      saveState: true,
      savePartial: partial,
      inputRevision: feedbackBatch.inputRevision || undefined,
      completedStudentIds: feedbackBatch.completedStudentIds,
      failedStudentIds: feedbackBatch.failedStudentIds,
      interruptionReason: feedbackBatch.interruptionReason || undefined,
      // 只提交持久化契约需要的字段；旧工作台缓存中的展示字段不会污染保存请求。
      students: feedbackCards.map((card) => ({
        id: card.id,
        name: card.name,
        labels: card.labels ?? [],
        feedback: card.feedback ?? "",
        ...(typeof card.draftFeedback === "string" ? { draftFeedback: card.draftFeedback } : {}),
        ...(card.reviewStatus ? { reviewStatus: card.reviewStatus } : {}),
        ...(Array.isArray(card.reviewIssues) ? { reviewIssues: card.reviewIssues } : {}),
        ...(card.sections ? { sections: card.sections } : {}),
      })),
      lessonMaterial: effectiveLessonMaterial(),
      assessmentEvidence: confirmedAssessmentEvidence,
      routingOverrides,
      outputStrategy,
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
    setLessonMaterial(withoutLessonSummary(lessonMaterial));
    markFeedbackInputsChanged(feedbackCards.length ? "课程材料已改变，请重新生成反馈。" : "");
  }
  function updateAssessmentBriefRaw(value: string) {
    setAssessmentBriefRaw(value);
    setLessonMaterial(withoutLessonSummary(lessonMaterial));
    markFeedbackInputsChanged(feedbackCards.length ? "测验说明已改变，请重新生成反馈。" : "");
  }
  function organizeLessonMaterial() {
    const parsed = parseLessonFeedbackMaterial(groupFeedbackRaw, assessmentBriefRaw, sessionCode);
    setLessonMaterial({
      ...parsed,
      scriptLessonNumber: lessonMaterial.scriptLessonNumber,
      perfectPrivateTemplate: lessonMaterial.perfectPrivateTemplate,
      errorPrivateTemplate: lessonMaterial.errorPrivateTemplate,
    });
    markFeedbackInputsChanged(feedbackCards.length ? "课程材料已重新整理，请重新生成反馈。" : "课程材料已整理，可在下方检查。");
  }
  function applyFeedbackScriptEntry(entry: FeedbackScriptEntry) {
    const assessmentBrief = "";
    const parsed = parseLessonFeedbackMaterial(entry.groupFeedback, assessmentBrief, sessionCode);
    setGroupFeedbackRaw(entry.groupFeedback);
    setAssessmentBriefRaw(assessmentBrief);
    setLessonMaterial({
      ...parsed,
      lessonTitle: parsed.lessonTitle || entry.topic,
      scriptLessonNumber: entry.lessonNumber,
      perfectPrivateTemplate: entry.perfectPrivateFeedback,
      errorPrivateTemplate: entry.errorPrivateFeedback,
    });
    markFeedbackInputsChanged(feedbackCards.length
      ? `已套用第 ${entry.lessonNumber} 课话术，请重新生成反馈。`
      : `已套用第 ${entry.lessonNumber} 课话术，可继续检查和整理。`);
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
      ...withoutLessonSummary(lessonMaterial),
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
  function setParsedTeacherInterventions(index: number, interventions: TeacherIntervention[]) {
    setParsedResult(parsedResult
      ? {
        ...parsedResult,
        students: parsedResult.students.map((student, studentIndex) => studentIndex === index
          ? { ...student, teacherInterventions: interventions }
          : student),
      }
      : null);
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
    let receivedBatch = false;
    let streamCompleted = false;
    let streamRevision = "";
    let streamTotal = 0;
    let streamPhase: "draft" | "review" = "draft";
    const completedStudentIds = new Set<string>();
    const failedStudentIds = new Set<string>();
    const publishProgress = () => {
      dispatchFeedback({ type: "progress", done: completedStudentIds.size });
      setFeedbackBatch({
        status: "running",
        phase: streamPhase,
        inputRevision: streamRevision,
        total: streamTotal,
        completedStudentIds: [...completedStudentIds],
        failedStudentIds: [...failedStudentIds],
        interruptionReason: "",
      });
    };
    const recordOutcome = (studentId: string, failed: boolean) => {
      if (failed) failedStudentIds.add(studentId);
      else {
        completedStudentIds.add(studentId);
        failedStudentIds.delete(studentId);
      }
      publishProgress();
    };
    setGenerating(true); setError(""); setStatus(""); dispatchFeedback({ type: "reset" }); setFeedbackPhase("draft");
    setFeedbackBatch({ ...emptyFeedbackBatchProgress(), status: "running", phase: "draft" });
    workflow.start("生成课后反馈", "正在检查课次和反馈上下文…");
    workflow.transition("generating", "正在按本次反馈强度生成家长话术…");
    try {
      const response = await fetch("/api/report/feedback-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          sessionCode,
          semesterId,
          historyModule: "feedback",
          bypassCache: forceRegenerate,
          lessonMaterial: effectiveLessonMaterial(),
          assessmentEvidence: confirmedAssessmentEvidence,
          routingOverrides,
          outputStrategy,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      if ((response.headers.get("content-type") || "").includes("application/json")) {
        const data = FeedbackBatchJsonResponseSchema.parse(await response.json());
        adoptLessonMaterial(data.lessonMaterial);
        dispatchFeedback({ type: "init", cards: data.students || [], total: data.total, done: data.total });
        setFeedbackBatch({
          status: data.batchStatus === "incomplete" ? "incomplete" : "completed",
          phase: data.batchPhase === "draft" || data.batchPhase === "review" ? data.batchPhase : "completed",
          inputRevision: data.inputRevision ?? "",
          total: data.total,
          completedStudentIds: data.completedStudentIds ?? data.students.map((card) => card.id),
          failedStudentIds: data.failedStudentIds ?? [],
          interruptionReason: data.interruptionReason ?? "",
        });
        setFeedbackPhase("idle");
        setStatus(data.cached ? "已恢复最近一次生成结果。" : "已按本次反馈强度生成家长话术，请逐条检查后再导出。");
        dispatchFeedback({ type: "force", value: false });
        setActiveStep("export");
        workflow.transition("reviewing", "家长话术已生成，请处理待人工确认项。");
        return;
      }
      if (!response.body) throw new Error("生成流不可用");
      await readSSEStream(response.body.getReader(), {
        signal: controller.signal,
        parse: (value) => FeedbackBatchStreamEventSchema.parse(value),
        onEvent: (message) => {
        if (message.type === "init") {
          receivedBatch = true;
          streamRevision = message.inputRevision;
          streamTotal = message.total;
          streamPhase = "draft";
          dispatchFeedback({ type: "init", cards: message.students, total: message.total });
          setFeedbackPhase("draft");
          publishProgress();
          workflow.progress(0, `准备生成 ${message.total} 名学生的反馈…`);
        }
        else if (message.type === "draft") {
          const completed = Number(message.completed || 0);
          streamPhase = "draft";
          setFeedbackPhase("draft");
          workflow.progress(streamTotal ? completed / (streamTotal * 2) : 0, `生成 ${completed}/${streamTotal}`);
          dispatchFeedback({ type: "patch", studentId: message.studentId, patch: { feedback: message.feedback, draftFeedback: message.draftFeedback, reviewStatus: message.reviewStatus, reviewIssues: message.reviewIssues || [] } });
          if (!outputStrategy.suggestedFeedback || message.reviewStatus) {
            recordOutcome(message.studentId, message.reviewStatus === "needs_review");
          }
        }
        else if (message.type === "review") {
          const completed = Number(message.completed || 0);
          streamPhase = "review";
          setFeedbackPhase("review");
          workflow.progress(streamTotal ? (streamTotal + completed) / (streamTotal * 2) : 0, `成稿与审核 ${completed}/${streamTotal}`);
          dispatchFeedback({ type: "patch", studentId: message.studentId, patch: { feedback: message.feedback, draftFeedback: message.draftFeedback, reviewStatus: message.reviewStatus, reviewIssues: message.reviewIssues || [] } });
          recordOutcome(message.studentId, message.reviewStatus === "needs_review");
        }
        else if (message.type === "done") {
          streamCompleted = true;
          adoptLessonMaterial(message.lessonMaterial);
          dispatchFeedback({ type: "init", cards: message.students || [], total: message.total, done: message.total });
          setFeedbackBatch({
            status: "completed",
            phase: "completed",
            inputRevision: message.inputRevision ?? streamRevision,
            total: message.total,
            completedStudentIds: message.completedStudentIds ?? message.students.map((card) => card.id),
            failedStudentIds: message.failedStudentIds ?? message.students.filter((card) => card.reviewStatus === "needs_review").map((card) => card.id),
            interruptionReason: "",
          });
          setFeedbackPhase("idle");
          setStatus("已按本次反馈强度生成家长话术，请逐条检查后再导出。");
          dispatchFeedback({ type: "force", value: false });
          setActiveStep("export");
          workflow.transition("reviewing", "家长话术已生成，请处理待人工确认项。");
        }
        else if (message.type === "error") throw new Error(message.message || "批量生成失败");
        },
      });
      if (receivedBatch && !streamCompleted) throw new Error("反馈生成流提前结束");
    } catch (reason) {
      if (controller.signal.aborted) {
        setError("");
        setStatus(receivedBatch
          ? `批次未完成：已保留 ${completedStudentIds.size}/${streamTotal} 名学生的可用结果。`
          : "已取消本次反馈生成。");
        workflow.cancel("本次反馈生成已由教师取消。");
      } else {
        const message = errorMessage(reason, "批量生成失败");
        setError(message);
        workflow.fail(message, "generating");
      }
      if (receivedBatch) {
        setFeedbackBatch({
          status: "incomplete",
          phase: streamPhase,
          inputRevision: streamRevision,
          total: streamTotal,
          completedStudentIds: [...completedStudentIds],
          failedStudentIds: [...failedStudentIds],
          interruptionReason: controller.signal.aborted ? "教师取消了批次生成" : errorMessage(reason, "网络或生成流中断"),
        });
        dispatchFeedback({ type: "dirty", value: true });
        setActiveStep("export");
      } else {
        setFeedbackBatch(emptyFeedbackBatchProgress());
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
    dispatchFeedback({ type: "reset", forceRegenerate: true }); setFeedbackBatch(emptyFeedbackBatchProgress()); setFeedbackPhase("idle"); setError("");
    setStatus("旧批次已从当前工作区移除；下一次生成将使用当前模型重新处理。");
    workflow.reset(); setActiveStep("generate");
  }
  async function continueIncompleteBatch() {
    if (feedbackBatch.status !== "incomplete" || generating || !sessionCode) return;
    if (!feedbackBatch.inputRevision || forceRegenerate) {
      setFeedbackBatch((current) => ({
        ...current,
        status: "stale",
        interruptionReason: "无法确认旧批次与当前输入一致",
      }));
      setStatus("旧部分结果无法与当前输入安全合并；请放弃旧批次后重新生成。");
      return;
    }
    setGenerating(true); setError(""); setStatus("");
    workflow.start("继续未完成反馈", "正在核对输入版本…");
    try {
      const revision = await requestJson<{ inputRevision: string; total: number }>("/api/report/feedback-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionCode,
          semesterId,
          historyModule: "feedback",
          revisionOnly: true,
          lessonMaterial: effectiveLessonMaterial(),
          assessmentEvidence: confirmedAssessmentEvidence,
          routingOverrides,
          outputStrategy,
        }),
      });
      if (revision.inputRevision !== feedbackBatch.inputRevision || revision.total !== feedbackBatch.total) {
        dispatchFeedback({ type: "force", value: true });
        setFeedbackBatch((current) => ({
          ...current,
          status: "stale",
          interruptionReason: "服务端检测到输入版本或学生总数已经变化",
        }));
        setStatus("输入材料或学生范围已经变化，旧部分结果未合并；请重新生成。");
        return;
      }

      const targetIds = remainingFeedbackStudentIds(feedbackCards, feedbackBatch);
      const completed = new Set(feedbackBatch.completedStudentIds);
      const failed = new Set(feedbackBatch.failedStudentIds);
      workflow.transition("generating", `只处理剩余或失败的 ${targetIds.length} 名学生…`);
      for (const [index, studentId] of targetIds.entries()) {
        const card = feedbackCards.find((item) => item.id === studentId);
        if (!card) continue;
        const data = await requestJsonValidated(FeedbackSingleResponseSchema, "/api/report/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId,
            sessionCode,
            semesterId,
            lessonMaterial: effectiveLessonMaterial(),
            assessmentEvidence: confirmedAssessmentEvidence[studentId],
            feedbackIntensity: card.feedbackIntensity,
            outputStrategy,
          }),
        });
        adoptLessonMaterial(data.lessonMaterial);
        dispatchFeedback({ type: "patch", studentId, patch: {
          feedback: data.feedback || "",
          draftFeedback: data.draftFeedback,
          reviewStatus: data.reviewStatus,
          reviewIssues: data.reviewIssues || [],
        } });
        if (data.feedback?.trim() && data.reviewStatus !== "needs_review") {
          completed.add(studentId);
          failed.delete(studentId);
        } else {
          failed.add(studentId);
        }
        dispatchFeedback({ type: "progress", done: completed.size });
        setFeedbackBatch({
          ...feedbackBatch,
          status: "running",
          phase: "review",
          completedStudentIds: [...completed],
          failedStudentIds: [...failed],
          interruptionReason: "",
        });
        workflow.progress((index + 1) / targetIds.length, `继续处理 ${index + 1}/${targetIds.length}`);
      }
      const complete = completed.size >= feedbackBatch.total && failed.size === 0;
      setFeedbackBatch({
        ...feedbackBatch,
        status: complete ? "completed" : "incomplete",
        phase: complete ? "completed" : "review",
        completedStudentIds: [...completed],
        failedStudentIds: [...failed],
        interruptionReason: complete ? "" : "仍有学生需要单独重试或教师填写",
      });
      dispatchFeedback({ type: "dirty", value: true });
      setStatus(complete
        ? "剩余学生已处理完成，请逐条检查后再导出。"
        : `已继续处理，当前有 ${failed.size} 名学生仍需重试或人工填写。`);
      workflow.transition("reviewing", complete ? "批次已补齐，请人工核对。" : "部分学生仍需人工处理。");
    } catch (reason) {
      const message = errorMessage(reason, "继续处理失败");
      setError(message);
      setFeedbackBatch((current) => ({
        ...current,
        status: "incomplete",
        phase: "review",
        interruptionReason: message,
      }));
      workflow.fail(message, "generating");
    } finally {
      setGenerating(false);
    }
  }
  async function savePartialFeedbackState() {
    if (feedbackBatch.status !== "incomplete" || !feedbackBatch.completedStudentIds.length) return;
    setError(""); setStatus("");
    try {
      await requestJson("/api/report/feedback-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedbackSavePayload(true)),
      });
      dispatchFeedback({ type: "dirty", value: false });
      setStatus(`已显式保存 ${feedbackBatch.completedStudentIds.length}/${feedbackBatch.total} 名学生的部分结果；该记录仍不能导出。`);
    } catch (reason) {
      setError(errorMessage(reason, "保存部分结果失败"));
    }
  }
  function abandonIncompleteBatch() {
    dispatchFeedback({ type: "reset", forceRegenerate: true });
    setFeedbackBatch(emptyFeedbackBatchProgress());
    setFeedbackPhase("idle"); setError("");
    setStatus("未完成批次已放弃；旧部分结果不会进入下一批次。");
    workflow.reset(); setActiveStep("generate");
  }
  async function regenerateOne(studentId: string, retryStrategy: FeedbackOutputStrategy = outputStrategy) {
    if (!sessionCode || !feedbackCards.some((card) => card.id === studentId)) return;
    if (feedbackBatch.status === "stale") {
      setError("反馈输入已经变化，不能把单人重写混入旧批次；请重新生成。");
      return;
    }
    const card = feedbackCards.find((item) => item.id === studentId);
    setRegeneratingId(studentId); setError("");
    setStatus(`${card?.name ?? "该学生"}正在重试，请稍候…`);
    try {
      const data = await requestJsonValidated(FeedbackSingleResponseSchema, "/api/report/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studentId, sessionCode, semesterId, inputRevision: feedbackBatch.inputRevision, lessonMaterial: effectiveLessonMaterial(), assessmentEvidence: confirmedAssessmentEvidence[studentId], feedbackIntensity: card?.feedbackIntensity, outputStrategy: normalizeFeedbackOutputStrategy(retryStrategy) }) });
      adoptLessonMaterial(data.lessonMaterial);
      dispatchFeedback({ type: "patch", studentId, patch: { feedback: data.feedback || "", draftFeedback: data.draftFeedback, reviewStatus: data.reviewStatus, reviewIssues: data.reviewIssues || [] } });
      dispatchFeedback({ type: "dirty", value: true });
      setStatus(`${card?.name ?? "该学生"}重试完成，已使用本次选择的反馈维度。`);
      if (feedbackBatch.status === "incomplete") {
        setFeedbackBatch((current) => {
          const next = updateStudentProgress(current, studentId, data.feedback?.trim() && data.reviewStatus !== "needs_review" ? "completed" : "failed");
          const complete = next.completedStudentIds.length >= next.total && next.failedStudentIds.length === 0;
          return complete ? { ...next, status: "completed", phase: "completed", interruptionReason: "" } : next;
        });
      }
    }
    catch (reason) { setError(errorMessage(reason, "重新生成失败")); }
    finally { setRegeneratingId(""); }
  }
  async function regenerateFeedbackVersion(
    studentId: string,
    retryStrategy: FeedbackOutputStrategy = outputStrategy,
  ) {
    if (!feedbackVersionProfileId) {
      setError("请先在系统中心保存至少一个 LLM 配置。");
      return;
    }
    const source = feedbackVersions.find((version) => (
      version.studentId === studentId && version.selected && version.replayable && !version.stale
    )) ?? feedbackVersions.find((version) => (
      version.studentId === studentId && version.replayable && !version.stale
    ));
    if (!source) {
      setError("该学生没有可重放的当前输入版本。");
      return;
    }
    setFeedbackVersionBusyId(studentId);
    setError("");
    const card = feedbackCards.find((item) => item.id === studentId);
    setStatus(`${card?.name ?? "该学生"}正在用所选模型和反馈维度重试…`);
    try {
      const result = await requestJson<{ results: Array<{ status: string; error?: string }> }>(
        "/api/report/feedback-versions/regenerate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profileId: feedbackVersionProfileId,
            items: [{
              studentId,
              sourceGenerationId: source.id,
              style: retryStrategy.style,
              length: retryStrategy.length,
            }],
          }),
        },
      );
      const item = result.results[0];
      if (item?.status === "error") throw new Error(item.error || "生成派生版本失败");
      await refreshFeedbackVersions();
      setStatus(item?.status === "existing"
        ? "相同输入、模型和反馈维度的版本已存在。"
        : `${card?.name ?? "该学生"}重试完成；请核对后显式采用新版本。`);
    } catch (reason) {
      setError(errorMessage(reason, "生成派生版本失败"));
    } finally {
      setFeedbackVersionBusyId("");
    }
  }
  async function selectFeedbackVersion(studentId: string, generationId: string) {
    setFeedbackVersionBusyId(studentId);
    setError("");
    try {
      const selected = await requestJson<{
        finalText: string;
        reviewStatus: FeedbackReviewStatus | null;
      }>("/api/report/feedback-versions/selection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionCode, studentId, generationId }),
      });
      dispatchFeedback({
        type: "patch",
        studentId,
        patch: {
          feedback: selected.finalText,
          reviewStatus: selected.reviewStatus ?? "edited",
          reviewIssues: selected.reviewStatus === "needs_review"
            ? ["所选版本仍需人工确认"]
            : ["教师已显式采用此生成版本"],
        },
      });
      dispatchFeedback({ type: "dirty", value: true });
      await refreshFeedbackVersions();
      setStatus("已切换当前采用版本；导出将使用该版本。");
    } catch (reason) {
      setError(errorMessage(reason, "选择反馈版本失败"));
    } finally {
      setFeedbackVersionBusyId("");
    }
  }
  function updateFeedback(studentId: string, feedback: string) {
    dispatchFeedback({
      type: "patch",
      studentId,
      patch: {
        feedback,
        reviewStatus: "edited",
        reviewIssues: ["教师已人工修改，导出以当前文本为准"],
      },
    });
    dispatchFeedback({ type: "dirty", value: true });
    if (feedback.trim() && feedbackBatch.status === "incomplete") {
      setFeedbackBatch((current) => {
        const next = updateStudentProgress(current, studentId, "completed");
        const complete = next.completedStudentIds.length >= next.total && next.failedStudentIds.length === 0;
        return complete ? { ...next, status: "completed", phase: "completed", interruptionReason: "" } : next;
      });
    }
  }
  function setFeedbackIntensity(studentId: string, intensity: FeedbackIntensity | "automatic") {
    setRoutingOverrides((current) => {
      if (intensity === "automatic") {
        const next = { ...current };
        delete next[studentId];
        return next;
      }
      return { ...current, [studentId]: intensity };
    });
    markFeedbackInputsChanged(feedbackCards.length ? "反馈档位已改变，请重新生成反馈。" : "反馈档位已调整。");
  }
  function setOutputStrategy(strategy: FeedbackOutputStrategy) {
    setOutputStrategyState(normalizeFeedbackOutputStrategy(strategy));
    markFeedbackInputsChanged(feedbackCards.length ? "输出策略已改变，请重新生成反馈。" : "已更新本批次输出策略。");
  }
  async function saveFeedbackState() { if (!sessionCode || !feedbackCards.length) return; await requestJson("/api/report/feedback-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(feedbackSavePayload()) }); dispatchFeedback({ type: "dirty", value: false }); }
  async function exportFeedback() {
    if (!sessionCode || !feedbackCards.length) return;
    if (!feedbackBatchCanExport(feedbackBatch, forceRegenerate)) {
      setError(feedbackBatch.status === "stale"
        ? "反馈输入已经变化，旧结果不能导出；请重新生成。"
        : "当前批次未完成，不能导出；请继续处理、保存部分结果或放弃本批次。");
      return;
    }
    const blockerCount = feedbackCards.filter((card) => (
      card.reviewStatus === "needs_review" && !isLegacyLengthOnlyReview(card.reviewIssues)
    )).length;
    if (blockerCount > 0) {
      setError(`还有 ${blockerCount} 条反馈需要人工确认；请修改或重新生成后再导出。`);
      return;
    }
    setExporting(true); setError("");
    workflow.start("保存并导出反馈", "正在检查最终反馈文本…"); workflow.transition("saving", "正在保存修改并准备 Excel…");
    try {
      if (feedbackDirty) await saveFeedbackState();
      const response = await fetch(`/api/report/feedback-batch?sessionCode=${encodeURIComponent(sessionCode)}&semesterId=${encodeURIComponent(semesterId)}&module=feedback`);
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || `导出请求失败（HTTP ${response.status}）`);
      }
      const blob = await response.blob();
      if (
        blob.size < 512
        || !response.headers.get("content-type")?.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      ) {
        throw new Error("服务器未返回有效的 Excel 文件，请查看页面错误后重试。");
      }
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `feedback_${sessionCode}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      setStatus(`已导出课后反馈表（${Math.ceil(blob.size / 1024)} KB）。`);
      workflow.transition("completed", "最终反馈已保存，Excel 文件已下载。");
    }
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
    const restoredBatch = restoreFeedbackBatchProgress({
      saved: {
        status: state.batchStatus === "incomplete" ? "incomplete" : "completed",
        phase: state.batchPhase ?? (state.batchStatus === "incomplete" ? "review" : "completed"),
        inputRevision: state.inputRevision ?? "",
        total: state.total,
        completedStudentIds: state.completedStudentIds ?? state.students.map((card) => card.id),
        failedStudentIds: state.failedStudentIds ?? [],
        interruptionReason: state.interruptionReason ?? "",
      },
      cards: state.students,
      total: state.total,
      legacyDone: state.batchStatus === "incomplete" ? state.completedStudentIds?.length ?? 0 : state.total,
    });
    const restoredCards = state.students.map((card) => (
      card.reviewStatus === "needs_review" && isLegacyLengthOnlyReview(card.reviewIssues)
        ? { ...card, reviewStatus: "passed" as const, reviewIssues: [] }
        : card
    ));
    dispatchFeedback({ type: "init", cards: restoredCards, total: state.total, done: restoredBatch.completedStudentIds.length });
    setFeedbackBatch(restoredBatch);
    setRoutingOverrides(state.routingOverrides ?? {});
    setOutputStrategyState(normalizeFeedbackOutputStrategy(state.outputStrategy));
    dispatchFeedback({ type: "force", value: false });
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
    setActiveStep("export"); setContextReloadKey((current) => current + 1); setError("");
    setStatus(restoredBatch.status === "incomplete"
      ? `批次未完成：已恢复 ${restoredBatch.completedStudentIds.length}/${restoredBatch.total} 名学生的已保存结果。`
      : "已恢复历史反馈结果。");
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
        ? { studentId: singleStudentId, sessionCode, semesterId, lessonMaterial: effectiveLessonMaterial(), assessmentEvidence: confirmedAssessmentEvidence[singleStudentId] }
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

  const feedbackReviewBlockerCount = feedbackCards.filter((card) => (
    card.reviewStatus === "needs_review" && !isLegacyLengthOnlyReview(card.reviewIssues)
  )).length;
  const canExportFeedback = feedbackBatchCanExport(feedbackBatch, forceRegenerate);
  const lessonMaterialNeedsOrganization = (
    lessonMaterial.groupFeedbackRaw !== groupFeedbackRaw.trim()
    || lessonMaterial.assessmentBriefRaw !== assessmentBriefRaw.trim()
  );

  return {
    activeStep, setActiveStep, context, contextHydrated, sessionRefreshKey, newSessionDate, setNewSessionDate, creatingSession, rawText, setRawText,
    parsing, assistantImporting, parseStatus, streamContent, draftId, parsedResult, reviewResult, corrections, confirming, confirmed,
    generating, regeneratingId, exporting, error, status, feedbackCards, feedbackTotal, feedbackDone, feedbackPhase, feedbackBatch, canExportFeedback, feedbackReviewBlockerCount, contextStudents, contextLoading,
    contextError, feedbackDirty, students, singleStudentId, setSingleStudentId, singleDays, setSingleDays, singleFeedback, singleDraftFeedback, singleReviewStatus, singleReviewIssues, updateSingleFeedback,
    groupFeedbackRaw, assessmentBriefRaw, lessonMaterial,
    assessmentImports: assessmentPdfs.items, assessmentBatchBusy: assessmentPdfs.busy,
    assessmentFolderPlan: assessmentPdfs.folderPlan, assessmentStudents,
    confirmedAssessmentEvidence, feedbackRouting, routingOverrides, outputStrategy,
    feedbackVersions, feedbackVersionProfiles, feedbackVersionProfileId, setFeedbackVersionProfileId, feedbackVersionBusyId,
    assessmentConfirmedCount: assessmentPdfs.confirmedCount,
    assessmentReadyCount: assessmentPdfs.readyCount,
    assessmentAttentionCount: assessmentPdfs.attentionCount,
    lessonMaterialNeedsOrganization,
    updateGroupFeedbackRaw, updateAssessmentBriefRaw, organizeLessonMaterial, clearLessonMaterials, updateLessonMaterialSection, applyFeedbackScriptEntry,
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
    onSemesterChange, onClassChange, onSessionChange, createSession, setParsedAttendance, setParsedTeacherInterventions, parse, importAssistantRoster, confirm, generate, cancelGeneration, prepareRegeneration,
    continueIncompleteBatch, savePartialFeedbackState, abandonIncompleteBatch,
    regenerateOne, regenerateFeedbackVersion, selectFeedbackVersion, updateFeedback, setFeedbackIntensity, setOutputStrategy, exportFeedback, restoreHistory, generateSingleFeedback,
  };
}
