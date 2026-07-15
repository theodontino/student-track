"use client";

import { useEffect, useMemo, useState } from "react";
import type { FeedbackContextStudent } from "@/components/wecom/types";
import { teachingContextWorkspaceKey, useTeachingContext } from "@/features/teaching-context";
import { useAiWorkflow } from "@/features/ai-workflow";
import { requestJson } from "@/lib/api-client";
import { saveWorkHistory } from "@/lib/history";
import { readSSEStream } from "@/lib/sse";
import type { DraftReviewResult, DraftStructuredResult, NameCorrection } from "@/lib/types";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import type { FeedbackCard, FeedbackContextResponse, FeedbackHistoryState, FeedbackStep, FeedbackStudentOption, FeedbackWorkspaceState, SingleFeedbackHistoryState } from "./types";
import { isFeedbackWorkspace, todayLocalDate } from "./workspace-state";

function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }

export function useFeedbackWorkspace() {
  const { context, hydrated: contextHydrated, setContext, setSemesterId, setClassName, setSessionCode } = useTeachingContext();
  const { semesterId, className, sessionCode } = context;
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [activeStep, setActiveStep] = useState<FeedbackStep>("prepare");
  const [newSessionDate, setNewSessionDate] = useState(todayLocalDate);
  const [creatingSession, setCreatingSession] = useState(false);
  const [rawText, setRawText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [assistantImporting, setAssistantImporting] = useState(false);
  const [parseStatus, setParseStatus] = useState("");
  const [streamContent, setStreamContent] = useState("");
  const [draftId, setDraftId] = useState("");
  const [parsedResult, setParsedResult] = useState<DraftStructuredResult | null>(null);
  const [reviewResult, setReviewResult] = useState<DraftReviewResult | null>(null);
  const [corrections, setCorrections] = useState<NameCorrection[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState("");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [feedbackCards, setFeedbackCards] = useState<FeedbackCard[]>([]);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackDone, setFeedbackDone] = useState(0);
  const [contextStudents, setContextStudents] = useState<FeedbackContextStudent[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const [contextReloadKey, setContextReloadKey] = useState(0);
  const [feedbackDirty, setFeedbackDirty] = useState(false);
  const [forceRegenerate, setForceRegenerate] = useState(false);
  const [students, setStudents] = useState<FeedbackStudentOption[]>([]);
  const [singleStudentId, setSingleStudentId] = useState("");
  const [singleDays, setSingleDays] = useState(14);
  const [singleFeedback, setSingleFeedback] = useState("");
  const [singleLoading, setSingleLoading] = useState(false);
  const workflow = useAiWorkflow();

  const workspaceValue = useMemo<FeedbackWorkspaceState>(() => ({
    activeStep, context, newSessionDate, rawText, parseStatus, streamContent, draftId, parsedResult,
    reviewResult, corrections, confirmed, status, feedbackCards, feedbackTotal, feedbackDone,
    feedbackDirty, forceRegenerate, singleStudentId, singleDays, singleFeedback, workflow: workflow.state,
  }), [activeStep, context, newSessionDate, rawText, parseStatus, streamContent, draftId, parsedResult, reviewResult, corrections, confirmed, status, feedbackCards, feedbackTotal, feedbackDone, feedbackDirty, forceRegenerate, singleStudentId, singleDays, singleFeedback, workflow.state]);

  const workspace = useSessionWorkspace({
    key: teachingContextWorkspaceKey("feedback", context), value: workspaceValue,
    validate: isFeedbackWorkspace, enabled: contextHydrated,
    restore: (saved) => {
      setActiveStep(saved?.activeStep ?? (saved?.feedbackCards.length ? "export" : saved?.confirmed ? "generate" : saved?.parsedResult ? "review" : saved?.rawText ? "extract" : "prepare"));
      setNewSessionDate(saved?.newSessionDate ?? todayLocalDate());
      setRawText(saved?.rawText ?? ""); setParseStatus(saved?.parseStatus ?? ""); setStreamContent(saved?.streamContent ?? "");
      setDraftId(saved?.draftId ?? ""); setParsedResult(saved?.parsedResult ?? null); setReviewResult(saved?.reviewResult ?? null);
      setCorrections(saved?.corrections ?? []); setConfirmed(saved?.confirmed ?? false);
      setFeedbackCards(saved?.feedbackCards ?? []); setFeedbackTotal(saved?.feedbackTotal ?? 0); setFeedbackDone(saved?.feedbackDone ?? 0);
      setFeedbackDirty(saved?.feedbackDirty ?? false); setForceRegenerate(saved?.forceRegenerate ?? false);
      setSingleStudentId(saved?.singleStudentId ?? ""); setSingleDays(saved?.singleDays ?? 14); setSingleFeedback(saved?.singleFeedback ?? "");
      workflow.restore(saved?.workflow);
      setStatus(saved ? saved.status || "已恢复上次离开时的页面内容。" : ""); setError("");
    },
  });

  const contextByStudent = useMemo(() => new Map(contextStudents.map((student) => [student.id, student])), [contextStudents]);
  useEffect(() => { requestJson<FeedbackStudentOption[]>("/api/students").then(setStudents).catch(() => setStudents([])); }, []);
  useEffect(() => {
    if (!workspace.hydrated) return;
    const draft = sessionStorage.getItem("chem-track:feedback-draft");
    if (!draft) return;
    setRawText(draft); setParseStatus("已从录音转写载入课后回顾。"); sessionStorage.removeItem("chem-track:feedback-draft");
  }, [workspace.hydrated]);
  useEffect(() => {
    if (!sessionCode) { setContextStudents([]); setContextError(""); return; }
    let cancelled = false;
    setContextLoading(true); setContextError("");
    requestJson<FeedbackContextResponse>(`/api/report/feedback-context?sessionCode=${encodeURIComponent(sessionCode)}`)
      .then((data) => { if (!cancelled) setContextStudents(data.students || []); })
      .catch((reason) => { if (!cancelled) { setContextStudents([]); setContextError(errorMessage(reason, "读取反馈上下文失败")); } })
      .finally(() => { if (!cancelled) setContextLoading(false); });
    return () => { cancelled = true; };
  }, [sessionCode, contextReloadKey]);

  function resetFeedback() { setFeedbackCards([]); setFeedbackTotal(0); setFeedbackDone(0); setFeedbackDirty(false); setForceRegenerate(false); }
  function onSemesterChange(id: string) { setSemesterId(id); setClassName(""); setSessionCode(""); resetFeedback(); }
  function onClassChange(value: string) { setClassName(value); setSessionCode(""); resetFeedback(); }
  function onSessionChange(code: string) {
    setSessionCode(code); setDraftId(""); setParsedResult(null); setReviewResult(null); setCorrections([]); setConfirmed(false);
    resetFeedback(); workflow.reset(); setError(""); setStatus("");
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
    setParsedResult((current) => current ? { ...current, students: current.students.map((student, studentIndex) => studentIndex === index ? { ...student, present } : student) } : current);
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
      await readSSEStream(response.body.getReader(), (message) => {
        if (message.type === "status") setParseStatus(message.message);
        else if (message.type === "chunk") setStreamContent((current) => current + message.content);
        else if (message.type === "result") { setDraftId(message.draftId); setParsedResult(message.parsedResult); setReviewResult(message.reviewResult); setCorrections(message.corrections || []); setStatus("解析完成，请确认结构化记录。"); setActiveStep("review"); workflow.transition("reviewing", "结构化草案已生成，请人工核对后再写入。"); }
        else if (message.type === "error") throw new Error(message.message);
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
      setContextReloadKey((current) => current + 1); setFeedbackCards([]); setFeedbackDirty(false); setForceRegenerate(true);
      workflow.transition("completed", "结构化记录已经安全写入，反馈上下文已刷新。");
      setActiveStep("generate");
    } catch (reason) { const message = errorMessage(reason, "确认写入失败"); setError(message); workflow.fail(message, "saving"); }
    finally { setConfirming(false); }
  }
  async function generate() {
    if (!sessionCode) { setError("请先选择课次"); return; }
    setGenerating(true); setError(""); setStatus(""); setFeedbackCards([]); setFeedbackDone(0); setFeedbackDirty(false);
    workflow.start("生成课后反馈", "正在检查课次和反馈上下文…");
    workflow.transition("generating", "正在为学生逐条生成反馈…");
    try {
      const response = await fetch("/api/report/feedback-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionCode, historyModule: "feedback", bypassCache: forceRegenerate }) });
      if (!response.ok) throw new Error((await response.json()).error);
      if ((response.headers.get("content-type") || "").includes("application/json")) {
        const data = await response.json(); setFeedbackCards(data.students || []); setFeedbackTotal(data.total); setFeedbackDone(data.total); setStatus(data.cached ? "已恢复最近一次生成结果。" : "反馈已生成。"); setForceRegenerate(false); setActiveStep("export"); workflow.transition("reviewing", "反馈已就绪，请逐条检查和编辑后再导出。"); return;
      }
      if (!response.body) throw new Error("生成流不可用");
      let streamTotal = 0;
      await readSSEStream(response.body.getReader(), (message) => {
        if (message.type === "init") { streamTotal = message.total; setFeedbackTotal(message.total); setFeedbackCards(message.students); workflow.progress(0, `准备生成 ${message.total} 条反馈…`); }
        else if (message.type === "progress") { setFeedbackDone((current) => { const next = current + 1; workflow.progress(streamTotal ? next / streamTotal : 0, `已生成 ${next}/${streamTotal} 条反馈`); return next; }); setFeedbackCards((current) => current.map((card) => card.id === message.studentId ? { ...card, feedback: message.feedback } : card)); }
        else if (message.type === "done") { setFeedbackCards(message.students || []); setFeedbackTotal(message.total); setFeedbackDone(message.total); setStatus("反馈已生成，可逐条编辑后导出。"); setForceRegenerate(false); setActiveStep("export"); workflow.transition("reviewing", "反馈已就绪，请逐条检查和编辑后再导出。"); }
        else if (message.type === "error") throw new Error(message.message || "批量生成失败");
      });
    } catch (reason) { const message = errorMessage(reason, "批量生成失败"); setError(message); workflow.fail(message, "generating"); }
    finally { setGenerating(false); }
  }
  async function regenerateOne(studentId: string) {
    if (!sessionCode || !feedbackCards.some((card) => card.id === studentId)) return;
    setRegeneratingId(studentId); setError("");
    try { const data = await requestJson<{ feedback?: string }>("/api/report/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studentId, sessionCode }) }); setFeedbackCards((current) => current.map((card) => card.id === studentId ? { ...card, feedback: data.feedback || "" } : card)); setFeedbackDirty(true); }
    catch (reason) { setError(errorMessage(reason, "重新生成失败")); }
    finally { setRegeneratingId(""); }
  }
  function updateFeedback(studentId: string, feedback: string) { setFeedbackCards((current) => current.map((card) => card.id === studentId ? { ...card, feedback } : card)); setFeedbackDirty(true); }
  async function saveFeedbackState() { if (!sessionCode || !feedbackCards.length) return; await requestJson("/api/report/feedback-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionCode, historyModule: "feedback", saveState: true, students: feedbackCards }) }); setFeedbackDirty(false); }
  async function exportFeedback() {
    if (!sessionCode || !feedbackCards.length) return; setExporting(true); setError("");
    workflow.start("保存并导出反馈", "正在检查最终反馈文本…"); workflow.transition("saving", "正在保存修改并准备 Excel…");
    try { if (feedbackDirty) await saveFeedbackState(); const anchor = document.createElement("a"); anchor.href = `/api/report/feedback-batch?sessionCode=${sessionCode}&module=feedback`; anchor.download = `feedback_${sessionCode}.xlsx`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); setStatus("已准备导出文件。"); workflow.transition("completed", "最终反馈已保存，导出文件已准备完成。"); }
    catch (reason) { const message = errorMessage(reason, "导出失败"); setError(message); workflow.fail(message, "saving"); }
    finally { setExporting(false); }
  }
  function restoreHistory(state: FeedbackHistoryState) {
    if (state.kind === "single") { setContext({ semesterId: state.semesterId, className: state.className, sessionCode: state.sessionCode }); setSingleStudentId(state.studentId); setSingleDays(state.days); setSingleFeedback(state.feedback); setError(""); setStatus("已恢复单人反馈历史。"); return; }
    setContext({ semesterId: state.semesterId, className: state.className, sessionCode: state.sessionCode }); setFeedbackCards(state.students); setFeedbackTotal(state.total); setFeedbackDone(state.total); setFeedbackDirty(false); setForceRegenerate(false); setActiveStep("export"); setContextReloadKey((current) => current + 1); setError(""); setStatus("已恢复历史反馈结果。");
  }
  function markContextChanged() { setFeedbackCards([]); setFeedbackDone(0); setFeedbackTotal(0); setFeedbackDirty(false); setForceRegenerate(true); setContextReloadKey((current) => current + 1); setStatus("家校沟通已导入，反馈上下文已刷新。"); }
  async function generateSingleFeedback() {
    if (!singleStudentId) return; setSingleLoading(true); setError("");
    try {
      const body = sessionCode ? { studentId: singleStudentId, sessionCode } : { studentId: singleStudentId, days: singleDays };
      const data = await requestJson<{ feedback?: string }>("/api/report/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const feedback = data.feedback ?? ""; setSingleFeedback(feedback);
      await saveWorkHistory("feedback", `学生反馈 ${sessionCode || `近${singleDays}天`}`, { kind: "single", semesterId, className, studentId: singleStudentId, sessionCode, days: singleDays, feedback } satisfies SingleFeedbackHistoryState, sessionCode || singleStudentId);
    } catch (reason) { setError(errorMessage(reason, "生成单人反馈失败")); }
    finally { setSingleLoading(false); }
  }

  return {
    activeStep, setActiveStep, context, contextHydrated, sessionRefreshKey, newSessionDate, setNewSessionDate, creatingSession, rawText, setRawText,
    parsing, assistantImporting, parseStatus, streamContent, draftId, parsedResult, reviewResult, corrections, confirming, confirmed,
    generating, regeneratingId, exporting, error, status, feedbackCards, feedbackTotal, feedbackDone, contextStudents, contextLoading,
    contextError, feedbackDirty, students, singleStudentId, setSingleStudentId, singleDays, setSingleDays, singleFeedback, setSingleFeedback,
    singleLoading, contextByStudent, workflow: workflow.state, canParse: Boolean(rawText.trim() && sessionCode && !parsing), canConfirm: Boolean(draftId && parsedResult && !confirming), canGenerate: Boolean(sessionCode && !generating),
    onSemesterChange, onClassChange, onSessionChange, createSession, setParsedAttendance, parse, importAssistantRoster, confirm, generate,
    regenerateOne, updateFeedback, exportFeedback, restoreHistory, markContextChanged, generateSingleFeedback,
  };
}
