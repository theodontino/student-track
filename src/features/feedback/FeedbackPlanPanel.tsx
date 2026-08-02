"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Section, StatusBanner, Textarea } from "@/components/ui";
import {
  FEEDBACK_CLOSURE_TYPES,
  FEEDBACK_CLOSURES_BY_TYPE,
  FEEDBACK_MODULES,
  type FeedbackCompositionPlan,
  type FeedbackModule,
  type FeedbackPlanType,
  type FeedbackAuditSnapshot,
  type FeedbackEvidenceBundle,
} from "@/lib/feedback-plan";
import type { FeedbackContextStudent } from "./context-types";

type Workspace = {
  activeStep: string;
  setActiveStep: (step: "prepare" | "extract" | "review" | "generate" | "export") => void;
  context: { semesterId: string; className: string; sessionCode: string };
  contextStudents: FeedbackContextStudent[];
};

interface PlanItem {
  id: string;
  studentId: string | null;
  status: string;
  finalText: string | null;
  finalTextHash: string | null;
  evidenceSnapshot: string;
  compositionSnapshot: string;
  auditSnapshot: string;
  evidence?: FeedbackEvidenceBundle | null;
  composition?: FeedbackCompositionPlan | null;
  audit?: FeedbackAuditSnapshot | null;
  itemRevision: number;
  reviewMode?: "model" | "teacher_edited";
  student?: { name: string; studentId?: string; communicationPreference?: { preferenceSnapshot: string } | null } | null;
  tasks?: Array<{ id: string; action: string; status: string; dueType: string; dueDate?: string | null; dueSessionId?: string | null }>;
  attachments?: Array<{ id: string; displayName: string; mimeType: string; sizeBytes: number; sha256: string; relativeLocator: string; status: string }>;
}

interface Plan {
  id: string;
  type: FeedbackPlanType;
  purpose: string;
  status: string;
  sessionId?: string | null;
  rangeStartSessionId?: string | null;
  rangeEndSessionId?: string | null;
  items: PlanItem[];
  exportRuns?: Array<{ id: string; mode: string; manifestHash: string; isRepeat?: boolean; createdAt: string }>;
}

interface RosterCandidate {
  id: string;
  name: string;
  studentId: string;
  classId: string;
  rosterStatus: "ACTIVE" | "INACTIVE";
}

interface TaskDraft {
  action: string;
  dueType: "session" | "date";
  dueSessionId: string;
  dueDate: string;
}

interface ApiFailurePayload {
  error?: string | { message?: string; code?: string };
  code?: string;
}

function apiFailureMessage(payload: ApiFailurePayload | null | undefined, fallback: string) {
  if (typeof payload?.error === "string") return payload.error;
  return payload?.error?.message || fallback;
}

function apiFailureCode(payload: ApiFailurePayload | null | undefined) {
  return payload?.code || (typeof payload?.error === "object" ? payload.error.code : undefined);
}

const typeLabels: Record<FeedbackPlanType, string> = {
  class_update: "班级公共反馈",
  event_micro: "事件型微反馈",
  stage_trend: "阶段趋势反馈",
  course_end: "结课教学总结",
};

const closureLabels: Record<string, string> = {
  informational: "知情型",
  positive_recognition: "具体认可",
  teacher_resolved: "课堂已处理",
  home_cooperation: "家庭配合",
  continued_observation: "后续观察",
};

const moduleLabels: Record<string, string> = {
  lesson_scope: "本课内容",
  key_difficulty: "关键难点",
  class_handling: "班级处理",
  homework_review: "作业与复习",
  next_lesson_link: "下次课衔接",
  observed_moment: "具体表现",
  teacher_interpretation: "教师判断",
  teacher_intervention: "老师已经做了什么",
  intervention_outcome: "处理结果",
  parent_action: "家长最低动作",
  followup_observation: "后续观察",
  starting_point: "阶段起点",
  recent_trend: "近期趋势",
  stable_capability: "已稳定能力",
  unresolved_issue: "尚未稳定问题",
  teacher_support: "阶段内教师支持",
  next_stage_focus: "下一阶段重点",
  starting_state: "起点状态",
  evidence_backed_change: "有证据的变化",
  remaining_gap: "剩余断点",
  next_stage_learning_path: "下一阶段学习路径",
};

const preferenceLabels: Record<string, string> = {
  unknown: "未设置",
  short: "简短",
  standard: "标准",
  detailed: "详细",
  teacher_conclusion: "教师结论",
  classroom_example: "课堂例子",
  data_trend: "数据趋势",
  plain: "生活化",
  basic: "基础术语",
  professional: "专业细节",
  inform_only: "只需知情",
  remind_confirm: "提醒确认",
  observe_report: "观察反馈",
  simple_check: "简单检查",
  every_session: "每次反馈",
  stage_only: "阶段总结",
  exception_only: "仅异常时",
};

function preferenceLabel(value: unknown) {
  return typeof value === "string" ? preferenceLabels[value] ?? value : "未设置";
}

const statusLabels: Record<string, string> = {
  draft: "草稿",
  generating: "生成中",
  in_review: "待复核",
  partially_approved: "部分已批准",
  approved: "已批准",
  partially_exported: "部分已导出",
  exported: "已导出",
  stale: "证据已变化",
  evidence_ready: "证据就绪",
  needs_review: "待教师批准",
  exported_item: "已导出",
};

function parseObject(value: string | Record<string, unknown> | undefined | null) {
  if (value && typeof value === "object") return value as Record<string, any>;
  if (!value) return {} as Record<string, any>;
  try { return JSON.parse(value) as Record<string, any>; } catch { return {}; }
}

function parseComposition(value: string | undefined, planType?: FeedbackPlanType, parsed?: FeedbackCompositionPlan | null): FeedbackCompositionPlan {
  if (parsed) return parsed;
  const compositionData = parseObject(value);
  const modules = Array.isArray(compositionData.modules)
    ? compositionData.modules.filter((module): module is FeedbackModule => Boolean(module && typeof module.key === "string"))
    : [];
  return {
    version: 1,
    closureType: typeof compositionData.closureType === "string"
      ? compositionData.closureType as FeedbackCompositionPlan["closureType"]
      : planType === "class_update" ? "informational" : "positive_recognition",
    needParentAction: compositionData.needParentAction === true,
    parentAction: compositionData.parentAction && typeof compositionData.parentAction === "object" ? compositionData.parentAction : null,
    modules,
    draftFeedback: typeof compositionData.draftFeedback === "string" ? compositionData.draftFeedback : "",
  };
}

function planStatusLabel(status: string) {
  return statusLabels[status] ?? status;
}

function auditStatus(item: PlanItem) {
  const audit = item.audit ?? parseObject(item.auditSnapshot);
  return typeof audit.status === "string" ? audit.status : "needs_review";
}

function canRegenerate(item: PlanItem) {
  return ["evidence_ready", "stale", "needs_review"].includes(item.status)
    && (item.reviewMode !== "teacher_edited" || item.status === "stale");
}

export function FeedbackPlanPanel({ workspace }: { workspace: Workspace }) {
  const showPanel = workspace.activeStep === "prepare" || workspace.activeStep === "generate" || workspace.activeStep === "export";
  const [type, setType] = useState<FeedbackPlanType>("event_micro");
  const [purpose, setPurpose] = useState("记录本次最值得家长了解的教学信息");
  const [sessionMeta, setSessionMeta] = useState<{ classId: string; sessionId: string } | null>(null);
  const [rangeSessions, setRangeSessions] = useState<Array<{ id: string; code: string; date: string; semesterNumber: number }>>([]);
  const [rangeContextStudents, setRangeContextStudents] = useState<FeedbackContextStudent[]>([]);
  const [rangeStartSessionId, setRangeStartSessionId] = useState("");
  const [rangeEndSessionId, setRangeEndSessionId] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [inactiveCandidates, setInactiveCandidates] = useState<RosterCandidate[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { text: string; revision: number }>>({});
  const [taskDrafts, setTaskDrafts] = useState<Record<string, TaskDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number; current: string; errors: string[] } | null>(null);
  const [repeatExportRequest, setRepeatExportRequest] = useState<{ planId: string; mode: "complete" | "approved_only" } | null>(null);
  const candidateDefaultsKey = useRef("");

  const candidateSourceStudents = type === "stage_trend" || type === "course_end"
    ? (rangeContextStudents.length ? rangeContextStudents : workspace.contextStudents)
    : workspace.contextStudents;
  const recommendedStudents = useMemo(() => candidateSourceStudents.filter((student) => (
    (student.feedbackRecommendationReasons?.length ?? 0) > 0
  )), [candidateSourceStudents]);
  const candidateStudents = useMemo(() => {
    if (type === "event_micro") return candidateSourceStudents;
    return candidateSourceStudents.filter((student) => student.preview.today.length > 0 || student.preview.trend !== "暂无近期评分趋势");
  }, [type, candidateSourceStudents]);

  const loadContextMeta = useCallback(async () => {
    if (!workspace.context.sessionCode) return;
    const response = await fetch(`/api/report/feedback-context?sessionCode=${encodeURIComponent(workspace.context.sessionCode)}`);
    if (!response.ok) throw new Error("无法读取当前课次信息");
    const payload = await response.json() as { session?: { id: string; classId: string } };
    if (!payload.session) throw new Error("当前课次缺少班级信息");
    setSessionMeta({ classId: payload.session.classId, sessionId: payload.session.id });
  }, [workspace.context.sessionCode]);

  const loadPlans = useCallback(async () => {
    if (!sessionMeta) return;
    const query = new URLSearchParams({ classId: sessionMeta.classId, semesterId: workspace.context.semesterId });
    const response = await fetch(`/api/report/feedback-plans?${query.toString()}`);
    if (!response.ok) throw new Error("无法读取反馈计划");
    const payload = await response.json() as { plans: Plan[] };
    setPlans(payload.plans);
    setPlansLoaded(true);
  }, [sessionMeta, workspace.context.semesterId]);

  const loadInactiveCandidates = useCallback(async () => {
    if (!sessionMeta || (type !== "stage_trend" && type !== "course_end")) {
      setInactiveCandidates([]);
      return;
    }
    const response = await fetch("/api/students?scope=all");
    if (!response.ok) throw new Error("无法读取停读学生名单");
    const students = await response.json() as RosterCandidate[];
    setInactiveCandidates(students.filter((student) => student.classId === sessionMeta.classId && student.rosterStatus === "INACTIVE"));
  }, [sessionMeta, type]);

  const loadRangeSessions = useCallback(async () => {
    if (!workspace.context.semesterId || !workspace.context.className) return;
    const query = new URLSearchParams({ semesterId: workspace.context.semesterId, className: workspace.context.className });
    const response = await fetch(`/api/sessions?${query.toString()}`);
    if (!response.ok) throw new Error("无法读取阶段范围课次");
    const payload = await response.json() as Array<{ id: string; code: string; date: string; semesterNumber: number }>;
    setRangeSessions(payload);
  }, [workspace.context.className, workspace.context.semesterId]);

  const loadRangeContext = useCallback(async () => {
    if (!sessionMeta || (type !== "stage_trend" && type !== "course_end") || rangeSessions.length === 0) {
      setRangeContextStudents([]);
      return;
    }
    const end = rangeSessions.find((session) => session.id === (rangeEndSessionId || sessionMeta.sessionId));
    const eligible = rangeSessions.filter((session) => !end || session.date < end.date || (session.date === end.date && session.semesterNumber <= end.semesterNumber));
    const selectedRange = rangeStartSessionId
      ? eligible.slice(Math.max(0, eligible.findIndex((session) => session.id === rangeStartSessionId)))
      : type === "stage_trend" ? eligible.slice(-4) : eligible;
    const sessionIds = selectedRange.map((session) => session.id);
    if (!sessionIds.length) return;
    const query = new URLSearchParams({ sessionCode: workspace.context.sessionCode, sessionIds: sessionIds.join(",") });
    const response = await fetch(`/api/report/feedback-context?${query.toString()}`);
    if (!response.ok) throw new Error("无法读取阶段范围候选学生");
    const payload = await response.json() as { students?: FeedbackContextStudent[] };
    setRangeContextStudents(payload.students ?? []);
  }, [rangeEndSessionId, rangeSessions, rangeStartSessionId, sessionMeta, type, workspace.context.sessionCode]);

  useEffect(() => {
    setSessionMeta(null);
    setActivePlan(null);
    setPlans([]);
    setPlansLoaded(false);
    setInactiveCandidates([]);
    setDrafts({});
    setSelectedItemIds([]);
    setProgress(null);
    setRepeatExportRequest(null);
    candidateDefaultsKey.current = "";
    void loadContextMeta().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取课次信息"));
  }, [loadContextMeta]);
  useEffect(() => {
    if (!sessionMeta) return;
    void loadPlans().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取反馈计划"));
  }, [loadPlans, sessionMeta]);
  useEffect(() => {
    if (workspace.activeStep === "prepare" || activePlan || !sessionMeta || !plansLoaded) return;
    const candidate = plans.find((plan) => (
      plan.sessionId === sessionMeta.sessionId
      || plan.rangeEndSessionId === sessionMeta.sessionId
    ));
    if (!candidate) return;
    let cancelled = false;
    void fetch(`/api/report/feedback-plans/${candidate.id}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("无法恢复当前课次的反馈计划");
        return response.json() as Promise<{ plan: Plan }>;
      })
      .then((payload) => { if (!cancelled) setActivePlan(payload.plan); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法恢复反馈计划"); });
    return () => { cancelled = true; };
  }, [activePlan, plans, plansLoaded, sessionMeta, workspace.activeStep]);
  useEffect(() => {
    void loadInactiveCandidates().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取停读学生名单"));
  }, [loadInactiveCandidates]);
  useEffect(() => {
    void loadRangeSessions().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取阶段范围课次"));
  }, [loadRangeSessions]);
  useEffect(() => {
    void loadRangeContext().catch((reason) => setError(reason instanceof Error ? reason.message : "无法读取阶段范围候选学生"));
  }, [loadRangeContext]);
  useEffect(() => {
    setRangeEndSessionId(sessionMeta?.sessionId ?? "");
  }, [sessionMeta?.sessionId]);
  useEffect(() => {
    const key = [
      workspace.context.sessionCode,
      type,
      rangeStartSessionId,
      rangeEndSessionId,
      candidateStudents.map((student) => student.id).join(","),
      recommendedStudents.map((student) => student.id).join(","),
    ].join(":");
    if (candidateDefaultsKey.current === key) return;
    candidateDefaultsKey.current = key;
    const defaultIds = type === "event_micro"
      ? recommendedStudents.map((student) => student.id)
      : candidateStudents.map((student) => student.id);
    setSelectedStudentIds(defaultIds);
  }, [candidateStudents, rangeEndSessionId, rangeStartSessionId, recommendedStudents, type, workspace.context.sessionCode]);
  useEffect(() => {
    if (!activePlan) return;
    setDrafts(Object.fromEntries(activePlan.items.map((item) => [item.id, {
      text: item.finalText ?? parseComposition(item.compositionSnapshot, activePlan.type, item.composition).draftFeedback ?? "",
      revision: item.itemRevision,
    }])));
    setSelectedItemIds(activePlan.items
      .filter((item) => !["approved", "exported", "stale", "generating"].includes(item.status))
      .map((item) => item.id));
  }, [activePlan]);

  async function createPlan() {
    if (!sessionMeta) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/report/feedback-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          purpose,
          semesterId: workspace.context.semesterId,
          classId: sessionMeta.classId,
          sessionId: sessionMeta.sessionId,
          rangeStartSessionId: type === "stage_trend" || type === "course_end" ? (rangeStartSessionId || undefined) : undefined,
          rangeEndSessionId: type === "stage_trend" || type === "course_end" ? (rangeEndSessionId || sessionMeta.sessionId) : sessionMeta.sessionId,
          ...(type === "class_update" ? {} : { studentIds: selectedStudentIds }),
        }),
      });
      const payload = await response.json() as { plan?: Plan } & ApiFailurePayload;
      if (!response.ok || !payload.plan) throw new Error(apiFailureMessage(payload, "创建反馈计划失败"));
      await openPlan(payload.plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建反馈计划失败"); }
    finally { setBusy(false); }
  }

  async function generatePlan(plan: Plan) {
    const itemIds = plan.items.filter(canRegenerate).map((item) => item.id);
    if (!itemIds.length) {
      setError("当前计划没有可重新生成的条目；已批准或已导出的版本需要通过新计划保留历史。");
      return;
    }
    setBusy(true); setError("");
    setProgress({ done: 0, total: itemIds.length, current: "准备生成…", errors: [] });
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate", stream: true, itemIds }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
        throw new Error(apiFailureMessage(payload, "生成反馈计划失败"));
      }
      if (!response.body) throw new Error("生成服务没有返回进度流");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handleEvent = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as { type?: string; itemId?: string; status?: string; message?: string; error?: string };
        if (event.type === "error") throw new Error(event.message || "生成反馈计划失败");
        if (event.type === "status") setProgress((current) => current ? { ...current, current: event.message || current.current } : current);
        if (event.type === "item") setProgress((current) => current ? {
          ...current,
          done: current.done + 1,
          current: event.message || event.itemId || current.current,
          errors: event.status === "error" ? [...current.errors, `${event.message || "反馈条目"}：${event.error || "生成失败"}`] : current.errors,
        } : current);
      };
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleEvent(line);
        if (chunk.done) break;
      }
      if (buffer.trim()) handleEvent(buffer);
      await openPlan(plan.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生成反馈计划失败");
      setProgress((current) => current ? { ...current, errors: [...current.errors, reason instanceof Error ? reason.message : "生成失败"] } : current);
      await openPlan(plan.id).catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function openPlan(id: string) {
    const response = await fetch(`/api/report/feedback-plans/${id}`);
    if (!response.ok) throw new Error("无法读取反馈计划详情");
    const payload = await response.json() as { plan: Plan };
    setActivePlan(payload.plan); await loadPlans();
  }

  async function saveItem(item: PlanItem) {
    if (!activePlan) return;
    const draft = drafts[item.id];
    if (!draft) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${activePlan.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "item", itemId: item.id, patch: { finalText: draft.text, reviewMode: "teacher_edited", expectedItemRevision: draft.revision } }),
      });
      const payload = await response.json() as ApiFailurePayload;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "保存反馈失败"));
      await openPlan(activePlan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存反馈失败"); }
    finally { setBusy(false); }
  }

  async function saveComposition(item: PlanItem, composition: FeedbackCompositionPlan) {
    if (!activePlan) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${activePlan.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "item", itemId: item.id, patch: { composition, expectedItemRevision: item.itemRevision } }),
      });
      const payload = await response.json() as ApiFailurePayload;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "保存模块选择失败"));
      await openPlan(activePlan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存模块选择失败"); }
    finally { setBusy(false); }
  }

  async function approvePlan(plan: Plan) {
    const approvable = plan.items.filter((item) => (
      selectedItemIds.includes(item.id)
      && !["approved", "exported", "stale", "generating"].includes(item.status)
      && Boolean(item.finalText?.trim())
      && auditStatus(item) !== "blocked"
    ));
    if (!approvable.length) {
      const selected = plan.items.filter((item) => selectedItemIds.includes(item.id));
      const failures = selected.map((item) => {
        const name = item.student?.name ?? "班级公共反馈";
        if (!item.finalText?.trim()) return `${name}：尚无最终文本`;
        if (["stale", "generating"].includes(item.status)) return `${name}：${planStatusLabel(item.status)}`;
        if (auditStatus(item) === "blocked") return `${name}：存在程序门禁阻断`;
        return `${name}：当前状态不能批准`;
      });
      setError(failures.length ? failures.join("；") : "请先选择要批准的反馈条目。");
      return;
    }
    setBusy(true); setError("");
    try {
      const expectedHashes = Object.fromEntries(approvable.map((item) => [item.id, item.finalTextHash || ""]));
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve", itemIds: approvable.map((item) => item.id), expectedHashes }),
      });
      const payload = await response.json() as ApiFailurePayload;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "批准反馈失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "批准反馈失败"); }
    finally { setBusy(false); }
  }

  async function createTask(plan: Plan, item: PlanItem) {
    const composition = parseObject(item.compositionSnapshot);
    const followup = (composition.modules || []).find((module: { key: string; content?: string }) => module.key === "followup_observation" || module.key === "teacher_support");
    const anchorId = plan.rangeEndSessionId || plan.sessionId;
    const anchorIndex = rangeSessions.findIndex((session) => session.id === anchorId);
    const nextSession = anchorIndex >= 0 ? rangeSessions[anchorIndex + 1] : undefined;
    const draft = taskDrafts[item.id] ?? {
      action: followup?.content || "在后续课次观察该问题是否稳定改善",
      dueType: nextSession ? "session" as const : "date" as const,
      dueSessionId: nextSession?.id ?? "",
      dueDate: "",
    };
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "task",
          itemId: item.id,
          taskAction: draft.action,
          dueType: draft.dueType,
          dueSessionId: draft.dueType === "session" ? draft.dueSessionId || undefined : undefined,
          dueDate: draft.dueType === "date" ? draft.dueDate : undefined,
          estimatedMinutes: 3,
          promiseExcerpt: followup?.content || draft.action,
        }),
      });
      const payload = await response.json() as ApiFailurePayload;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "创建教师任务失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建教师任务失败"); }
    finally { setBusy(false); }
  }

  async function uploadAttachment(plan: Plan, item: PlanItem, file: File | undefined) {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const form = new FormData(); form.set("file", file); form.set("itemId", item.id);
      const response = await fetch(`/api/report/feedback-plans/${plan.id}/attachments`, { method: "POST", body: form });
      const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "保存附件失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存附件失败"); }
    finally { setBusy(false); }
  }

  async function removeAttachment(plan: Plan, attachmentId: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}/attachments`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentId }),
      });
      const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "删除附件失败"));
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除附件失败"); }
    finally { setBusy(false); }
  }

  async function exportPlan(plan: Plan, mode: "complete" | "approved_only", allowRepeat = false) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "export", mode, allowRepeat }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
        if (apiFailureCode(payload) === "repeat_export") setRepeatExportRequest({ planId: plan.id, mode });
        throw new Error(apiFailureMessage(payload, "反馈计划导出失败"));
      }
      const blob = await response.blob();
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") || blob.size < 512) {
        throw new Error("导出响应不是有效的 Excel 文件，请重试或查看服务日志");
      }
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = href; anchor.download = `feedback-plan_${plan.id}.xlsx`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(href);
      setRepeatExportRequest(null);
      await openPlan(plan.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "反馈计划导出失败"); }
    finally { setBusy(false); }
  }

  async function deletePlan(plan: Plan) {
    if (!window.confirm(`确认删除“${typeLabels[plan.type]}”计划及其受控附件吗？此操作不可撤销。`)) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/report/feedback-plans/${plan.id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => null) as ApiFailurePayload | null;
      if (!response.ok) throw new Error(apiFailureMessage(payload, "删除反馈计划失败"));
      setActivePlan(null);
      await loadPlans();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除反馈计划失败"); }
    finally { setBusy(false); }
  }

  if (!showPanel) return null;
  const isPrepare = workspace.activeStep === "prepare";
  const isExport = workspace.activeStep === "export";
  const title = isPrepare ? "反馈计划" : isExport ? "批准与导出" : "生成与复核";
  const description = isPrepare
    ? "先选择反馈类型、范围和对象；系统只推荐，不替教师决定。"
    : isExport
      ? "只把已批准的教师最终文本写入 Excel；未批准条目不会进入导出。"
      : "按证据篮子组装可选模块，实时查看生成进度并处理程序门禁。";
  const canGenerate = Boolean(activePlan?.items.some(canRegenerate));
  const allItemsApproved = Boolean(activePlan?.items.length && activePlan.items.every((item) => ["approved", "exported"].includes(item.status)));

  return <Section title={title} description={description} className="feedback-plan-panel" actions={isPrepare ? <Button onClick={() => void createPlan()} disabled={busy || !sessionMeta || (type !== "class_update" && selectedStudentIds.length === 0)}>{busy ? "处理中…" : "创建反馈计划"}</Button> : activePlan ? <div className="feedback-plan-header-actions"><Button uiSize="sm" variant="secondary" onClick={() => void generatePlan(activePlan)} disabled={busy || !canGenerate}>{busy ? "生成中…" : activePlan.items.some((item) => item.finalText) ? "重新组装/生成" : "开始生成"}</Button><Button uiSize="sm" onClick={() => void approvePlan(activePlan)} disabled={busy || selectedItemIds.length === 0}>批准所选可通过项</Button>{isExport && <><Button uiSize="sm" variant="secondary" onClick={() => void exportPlan(activePlan, "complete")} disabled={busy || !allItemsApproved}>完整导出</Button><Button uiSize="sm" variant="secondary" onClick={() => void exportPlan(activePlan, "approved_only")} disabled={busy || !activePlan.items.some((item) => item.status === "approved")}>仅导出新批准项</Button></>}<Button uiSize="sm" variant="ghost" onClick={() => void deletePlan(activePlan)} disabled={busy}>删除计划</Button></div> : null}>
    {error && <StatusBanner tone="danger">{error}</StatusBanner>}
    {!isPrepare && !activePlan && plansLoaded && <StatusBanner tone="warning"><span>当前课次还没有可恢复的反馈计划，请先到“准备”步骤选择反馈类型和对象。</span><Button uiSize="sm" variant="secondary" onClick={() => workspace.setActiveStep("prepare")}>返回准备</Button></StatusBanner>}
    {repeatExportRequest && activePlan?.id === repeatExportRequest.planId && <StatusBanner tone="warning"><span>相同文本已经导出过。只有确实需要重新下载时才继续。</span><Button uiSize="sm" variant="secondary" onClick={() => void exportPlan(activePlan, repeatExportRequest.mode, true)} disabled={busy}>确认重复导出</Button><Button uiSize="sm" variant="ghost" onClick={() => setRepeatExportRequest(null)} disabled={busy}>取消</Button></StatusBanner>}
    {isPrepare && <div className="feedback-plan-create">
      <div className="feedback-plan-form-grid">
        <label><span>反馈类型</span><select aria-label="反馈类型" value={type} onChange={(event) => setType(event.target.value as FeedbackPlanType)}>{Object.entries(typeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label><span>本次目的</span><input value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
      </div>
      {type !== "class_update" && <fieldset className="feedback-plan-candidates">
        <legend>反馈对象</legend>
        <div className="feedback-plan-candidate-toolbar"><span>{selectedStudentIds.length} 人已选择</span><div><Button uiSize="sm" variant="ghost" onClick={() => setSelectedStudentIds(candidateStudents.map((student) => student.id))}>全选在读</Button><Button uiSize="sm" variant="ghost" onClick={() => setSelectedStudentIds([])}>清空</Button>{type === "event_micro" && <Button uiSize="sm" variant="ghost" onClick={() => setSelectedStudentIds(recommendedStudents.map((student) => student.id))}>仅推荐</Button>}</div></div>
        <div className="feedback-plan-candidate-grid">{candidateStudents.length ? candidateStudents.map((student) => { const recommended = recommendedStudents.some((candidate) => candidate.id === student.id); return <label key={student.id} className={selectedStudentIds.includes(student.id) ? "is-selected" : ""}><input type="checkbox" checked={selectedStudentIds.includes(student.id)} onChange={(event) => setSelectedStudentIds((ids) => event.target.checked ? [...new Set([...ids, student.id])] : ids.filter((id) => id !== student.id))} /><span><strong>{student.name}</strong><small>{recommended ? student.feedbackRecommendationReasons?.join("、") : "有确认记录，可手动加入"}</small></span></label>; }) : <span>当前上下文暂无候选学生</span>}</div>
        {(type === "stage_trend" || type === "course_end") && inactiveCandidates.length > 0 && <details className="feedback-plan-inactive-candidates"><summary>停读学生（仅手动加入）</summary><div className="feedback-plan-candidate-grid">{inactiveCandidates.map((student) => <label key={student.id} className={selectedStudentIds.includes(student.id) ? "is-selected" : ""}><input type="checkbox" checked={selectedStudentIds.includes(student.id)} onChange={(event) => setSelectedStudentIds((ids) => event.target.checked ? [...new Set([...ids, student.id])] : ids.filter((id) => id !== student.id))} /><span><strong>{student.name}</strong><small>停读 · 手动加入后按历史范围取证</small></span></label>)}</div></details>}
      </fieldset>}
      {(type === "stage_trend" || type === "course_end") && <fieldset className="feedback-plan-range"><legend>{type === "stage_trend" ? "阶段范围" : "学期范围"}</legend><p>{type === "stage_trend" ? "首次默认最近四次已完成课次，后续从上一份已批准阶段反馈之后开始。" : "默认覆盖当前学期截至当前课次的全部范围。"}</p><div className="feedback-plan-form-grid"><label><span>起始课次</span><select aria-label="反馈计划起始课次" value={rangeStartSessionId} onChange={(event) => setRangeStartSessionId(event.target.value)}><option value="">自动</option>{rangeSessions.map((session) => <option key={session.id} value={session.id}>{session.code} · {session.date} · 第{session.semesterNumber}次</option>)}</select></label><label><span>截止课次</span><select aria-label="反馈计划截止课次" value={rangeEndSessionId} onChange={(event) => setRangeEndSessionId(event.target.value)}>{rangeSessions.map((session) => <option key={session.id} value={session.id}>{session.code} · {session.date} · 第{session.semesterNumber}次</option>)}</select></label></div></fieldset>}
    </div>}
    {isPrepare && plans.length > 0 && <div className="feedback-plan-history"><div><strong>计划历史</strong><span>可恢复最近 8 个计划</span></div><div className="feedback-plan-history-list">{plans.slice(0, 8).map((plan) => <Button key={plan.id} uiSize="sm" variant={activePlan?.id === plan.id ? "secondary" : "ghost"} onClick={() => void openPlan(plan.id)}>{typeLabels[plan.type]} · {planStatusLabel(plan.status)} · {plan.items.length}条</Button>)}</div></div>}
    {progress && !isPrepare && <div className="feedback-plan-progress" role="status"><div><strong>生成进度 {progress.done}/{progress.total}</strong><span>{progress.current}</span></div><progress max={progress.total || 1} value={progress.done} />{progress.errors.length > 0 && <span className="feedback-plan-progress__error">{progress.errors.join("；")}</span>}</div>}
    {activePlan && !isPrepare && <div className="feedback-plan-detail"><header className="feedback-plan-detail__heading"><div><strong>{typeLabels[activePlan.type]}</strong><span>{activePlan.purpose}</span></div><Badge tone={activePlan.status === "stale" ? "danger" : activePlan.status === "approved" || activePlan.status === "exported" ? "success" : "warning"}>{planStatusLabel(activePlan.status)}</Badge></header><div className="feedback-plan-selection-toolbar"><span>已选择 {selectedItemIds.length}/{activePlan.items.length} 条</span><div><Button uiSize="sm" variant="ghost" onClick={() => setSelectedItemIds(activePlan.items.filter((item) => !["approved", "exported", "stale", "generating"].includes(item.status)).map((item) => item.id))}>选择可批准项</Button><Button uiSize="sm" variant="ghost" onClick={() => setSelectedItemIds([])}>清空</Button></div></div>{activePlan.items.map((item) => {
      const composition = parseComposition(item.compositionSnapshot, activePlan.type, item.composition);
      const audit = item.audit ?? parseObject(item.auditSnapshot);
      const evidence = item.evidence ?? parseObject(item.evidenceSnapshot);
      const allowedModules = FEEDBACK_MODULES[activePlan.type] as readonly string[];
      const moduleMap = new Map<string, FeedbackModule>(composition.modules.map((module) => [module.key, module]));
      const moduleRows: FeedbackModule[] = allowedModules.map((key) => moduleMap.get(key) ?? { key, content: "", evidenceRefs: [], status: "omitted", reason: "模型未选择" });
      const draft = drafts[item.id] ?? { text: item.finalText ?? composition.draftFeedback ?? "", revision: item.itemRevision };
      const updateModule = (key: string, enabled: boolean) => {
        const current = moduleMap.get(key);
        if (!current || current.status === "blocked") return;
        void saveComposition(item, { ...composition, modules: [...composition.modules.filter((module) => module.key !== key), { ...current, status: enabled ? "included" : "omitted", reason: enabled ? "教师选择" : "教师省略" }] });
      };
      const updateClosure = (closureType: string) => {
        if (FEEDBACK_CLOSURE_TYPES.includes(closureType as never)) void saveComposition(item, { ...composition, closureType: closureType as FeedbackCompositionPlan["closureType"] });
      };
      const blockedIssues = (audit.items || []).filter((issue: { severity: string }) => issue.severity === "blocked");
      const protocolIssueCodes = new Set(["module_not_allowed", "evidence_ref_missing", "module_count_invalid", "closure_not_allowed"]);
      const hasProtocolIssue = blockedIssues.some((issue: { code: string }) => protocolIssueCodes.has(issue.code));
      const visibleAuditIssues = (audit.items || []).filter((issue: { code: string }) => !protocolIssueCodes.has(issue.code));
      const preference = parseObject(item.student?.communicationPreference?.preferenceSnapshot);
      const anchorId = activePlan.rangeEndSessionId || activePlan.sessionId;
      const anchorIndex = rangeSessions.findIndex((session) => session.id === anchorId);
      const futureSessions = anchorIndex >= 0 ? rangeSessions.slice(anchorIndex + 1) : [];
      const followup = (composition.modules || []).find((module: { key: string; content?: string }) => module.key === "followup_observation" || module.key === "teacher_support");
      const taskDraft = taskDrafts[item.id] ?? {
        action: followup?.content || "在后续课次观察该问题是否稳定改善",
        dueType: futureSessions.length ? "session" as const : "date" as const,
        dueSessionId: futureSessions[0]?.id ?? "",
        dueDate: "",
      };
      const itemLabel = item.student?.name ?? (item.studentId ? "学生信息加载失败" : "班级公共反馈");
      const itemImmutable = ["approved", "exported", "stale", "generating"].includes(item.status);
      return <article key={item.id} className="feedback-plan-item">
        <header className="feedback-plan-item__heading"><label className="feedback-plan-item-select"><input type="checkbox" aria-label={`选择${itemLabel}反馈`} checked={selectedItemIds.includes(item.id)} disabled={itemImmutable} onChange={(event) => setSelectedItemIds((ids) => event.target.checked ? [...new Set([...ids, item.id])] : ids.filter((id) => id !== item.id))} /><span><strong>{itemLabel}</strong><small>{item.student?.studentId || (item.studentId ? "学生关系缺失" : "班级条目")} · 版本 {item.itemRevision}</small></span></label><Badge tone={blockedIssues.length || item.status === "stale" || (item.studentId && !item.student) ? "danger" : item.status === "approved" || item.status === "exported" ? "success" : "warning"}>{planStatusLabel(item.status)}</Badge></header>
        {item.studentId && !item.student && <StatusBanner tone="danger">学生身份没有加载完整，已禁止把该条目当作班级公共反馈。请刷新计划后重试。</StatusBanner>}
        <details className="feedback-plan-evidence"><summary>查看证据篮子与内部审核 <span>{(evidence.teachingEvidence || []).length} 条证据 · {audit.status || "待审核"}</span></summary><div className="feedback-plan-evidence__body"><p>{(evidence.teachingEvidence || []).map((entry: { content: string }) => entry.content).join("；") || "暂无已确认证据"}</p>{(evidence.communicationContext || []).length > 0 && <p className="feedback-plan-evidence__communication">沟通背景：{(evidence.communicationContext || []).map((entry: { content: string }) => entry.content).join("；")}</p>}{hasProtocolIssue && <StatusBanner tone="danger">生成结果使用了旧版或不匹配的反馈结构，已阻止批准。请点击顶部“重新组装/生成”，系统会按当前反馈类型重新整理。</StatusBanner>}{visibleAuditIssues.map((issue: { message: string; severity: string }, index: number) => <StatusBanner key={`${issue.message}-${index}`} tone={issue.severity === "blocked" ? "danger" : "warning"}>{issue.message}</StatusBanner>)}</div></details>
        {item.student && <details className="feedback-plan-preference"><summary>家庭沟通偏好</summary><p>长度：{preferenceLabel(preference.length)} · 证据：{preferenceLabel(preference.evidence)} · 术语：{preferenceLabel(preference.terminology)} · 家庭参与：{preferenceLabel(preference.familyParticipation)} · 频率：{preferenceLabel(preference.frequency)}</p></details>}
        <div className="feedback-plan-item__controls"><label><span>结尾类型</span><select value={composition.closureType || "positive_recognition"} onChange={(event) => updateClosure(event.target.value)} disabled={busy || itemImmutable}>{FEEDBACK_CLOSURES_BY_TYPE[activePlan.type].map((closure) => <option key={closure} value={closure}>{closureLabels[closure] || closure}</option>)}</select></label><div className="feedback-plan-modules"><span className="feedback-plan-label">可选模块</span>{moduleRows.map((module) => <label key={module.key} className={`feedback-plan-module feedback-plan-module--${module.status}`}><input type="checkbox" checked={module.status === "included"} disabled={busy || itemImmutable || module.status === "blocked" || !module.content} onChange={(event) => updateModule(module.key, event.target.checked)} /><span><strong>{moduleLabels[module.key] || module.key}</strong><small>{module.status === "blocked" ? `阻断：${module.reason || "缺证据"}` : !module.content ? "暂无可用证据" : module.reason || ""}</small></span></label>)}</div></div>
        <div className="feedback-plan-editor"><Textarea aria-label={`${itemLabel}反馈计划文本`} rows={5} value={draft.text} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: { ...draft, text: event.target.value } }))} disabled={busy || itemImmutable || Boolean(item.studentId && !item.student)} /><div className="feedback-plan-editor__actions"><span>{draft.text.length} 个字符 · 保存后重新运行程序门禁</span><Button uiSize="sm" onClick={() => void saveItem(item)} disabled={busy || itemImmutable || Boolean(item.studentId && !item.student)}>保存修改</Button></div></div>
        {item.tasks?.map((task) => <p className="feedback-plan-task" key={task.id}>教师任务：{task.action} · {task.status}</p>)}
        {item.attachments?.map((attachment) => <div className={`feedback-plan-attachment ${attachment.status === "missing" ? "is-missing" : ""}`} key={attachment.id}><span>发送附件：{attachment.displayName} · {attachment.sizeBytes}B · {attachment.status === "missing" ? "文件缺失，不能导出" : attachment.status}</span><Button uiSize="sm" variant="ghost" onClick={() => void removeAttachment(activePlan, attachment.id)} disabled={busy}>移除</Button></div>)}
        <div className="feedback-plan-item__footer">{blockedIssues.some((issue: { code: string }) => ["followup_without_task", "promise_without_task"].includes(issue.code)) && <div className="feedback-plan-task-form"><input aria-label={`${itemLabel}教师任务`} value={taskDraft.action} onChange={(event) => setTaskDrafts((current) => ({ ...current, [item.id]: { ...taskDraft, action: event.target.value } }))} /><select aria-label={`${itemLabel}任务截止方式`} value={taskDraft.dueType} onChange={(event) => setTaskDrafts((current) => ({ ...current, [item.id]: { ...taskDraft, dueType: event.target.value as TaskDraft["dueType"] } }))}><option value="session" disabled={futureSessions.length === 0}>按课次</option><option value="date">按日期</option></select>{taskDraft.dueType === "session" ? <select aria-label={`${itemLabel}任务截止课次`} value={taskDraft.dueSessionId} onChange={(event) => setTaskDrafts((current) => ({ ...current, [item.id]: { ...taskDraft, dueSessionId: event.target.value } }))}>{futureSessions.map((session) => <option key={session.id} value={session.id}>{session.date} · {session.code}</option>)}</select> : <input aria-label={`${itemLabel}任务截止日期`} type="date" value={taskDraft.dueDate} onChange={(event) => setTaskDrafts((current) => ({ ...current, [item.id]: { ...taskDraft, dueDate: event.target.value } }))} />}<Button uiSize="sm" variant="secondary" onClick={() => void createTask(activePlan, item)} disabled={busy || !taskDraft.action.trim() || (taskDraft.dueType === "date" && !taskDraft.dueDate)}>批准并创建教师任务</Button></div>}{isExport && <label className="feedback-plan-attachment-picker">标记发送附件<input type="file" onChange={(event) => void uploadAttachment(activePlan, item, event.target.files?.[0])} disabled={busy || item.status === "stale"} /></label>}</div>
      </article>;
    })}</div>}
    {isExport && activePlan?.exportRuns && activePlan.exportRuns.length > 0 && <div className="feedback-plan-exports"><strong>导出记录</strong>{activePlan.exportRuns.slice(0, 5).map((run, index) => { const isFirst = index === activePlan.exportRuns!.length - 1; const label = run.isRepeat ? "重复导出" : isFirst ? "首次导出" : run.mode === "approved_only" ? "补导" : "完整导出"; return <span key={run.id}>{label} · {new Date(run.createdAt).toLocaleString("zh-CN")} · {run.manifestHash.slice(0, 10)}…</span>; })}</div>}
  </Section>;
}
