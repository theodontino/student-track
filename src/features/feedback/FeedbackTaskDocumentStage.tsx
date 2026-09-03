"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, Input, StatusBanner, Textarea } from "@/components/ui";
import {
  FEEDBACK_CLOSURES_BY_TYPE,
  FEEDBACK_MODULES,
  defaultFeedbackGenerationPreferences,
  type FeedbackGenerationPreferences,
  type FeedbackPlanItemGenerationConfig,
  type FeedbackPlanType,
} from "@/lib/feedback-plan";
import type { LessonFeedbackMaterial } from "@/lib/feedback-materials";
import { requestJson } from "@/lib/api-client";
import type { FeedbackTaskCurrentFactsSeed, FeedbackTaskPreferences } from "./feedback-task-state";
import type { FeedbackStudioPlanTarget } from "./feedback-task-types";
import { FeedbackPlanGenerationConfigDialog, independentConfigFromCommon } from "./FeedbackPlanGenerationConfigDialog";
import styles from "./unified-feedback-workspace.module.css";

type IntakeSource = {
  intakeRunId: string;
  sessionCode: string;
  status: string;
  confirmedAt: string | null;
  sourceCount: number;
  recognizedCount: number;
  ignoredCount: number;
  issueCount: number;
  sources: Array<{ name: string; kind: string; source: string }>;
  resolvedDecisionCount?: number;
  resolutions?: Array<{ action: string; sourceName?: string | null; detail?: string }>;
};

type FrozenFact = {
  studentId: string | null;
  studentName?: string;
  studentNumber?: string;
  evidence: {
    teachingEvidence?: Array<{ id: string; content: string; confirmed?: boolean }>;
    assessmentEvidence?: Array<{ id: string; content: string; confirmed?: boolean }>;
  };
};

type PlanInput = {
  version?: number;
  lessonMaterial?: LessonFeedbackMaterial;
  selectedStudentIds?: string[];
  generationPreferences?: FeedbackGenerationPreferences;
  batchGenerationPreferences?: FeedbackGenerationPreferences;
  studentOverrides?: Array<{ studentId: string; generationConfig: FeedbackPlanItemGenerationConfig }>;
  factSnapshot?: { capturedAt: string; items: FrozenFact[] };
  intakeSources?: IntakeSource[];
};

type PlanDetail = {
  id: string;
  displayName?: string | null;
  basedOnPlanId?: string | null;
  type: FeedbackPlanType;
  status: string;
  outputRequirement: string;
  generationMode?: "standard" | "fast";
  generationStartedAt?: string | null;
  generationCompletedAt?: string | null;
  archivedAt?: string | null;
  planRevision?: number;
  inputSnapshot?: string;
  input?: PlanInput | null;
  class?: { id: string; code: string; name?: string | null } | null;
  session?: { id?: string; code: string; date?: string } | null;
  rangeStartSession?: { id?: string; code: string; date?: string } | null;
  rangeEndSession?: { id?: string; code: string; date?: string } | null;
  items: Array<{
    id: string;
    studentId: string | null;
    status: string;
    finalText?: string | null;
    selectedGenerationId?: string | null;
    approvedAt?: string | null;
    exportedAt?: string | null;
    student?: { id?: string; name: string; studentId?: string } | null;
    generationConfig?: FeedbackPlanItemGenerationConfig | null;
  }>;
};

type BatchDetail = {
  id: string;
  type: "event_micro" | "stage_trend";
  displayName?: string | null;
  basedOnBatchId?: string | null;
  status: string;
  outputRequirement: string;
  generationMode?: "standard" | "fast";
  planRevision?: number;
  sharedLessonRevision?: { id: string; groupLesson: { id: string } } | null;
  plans: Array<{
    id: string;
    class: { id: string; code: string; name?: string | null };
    session?: { code: string; groupLessonSession?: { groupLessonId: string } | null } | null;
    rangeEndSession?: { code: string; groupLessonSession?: { groupLessonId: string } | null } | null;
  }>;
};

type LoadedDocument = {
  kind: "plan" | "batch";
  plan: PlanDetail;
  plans: PlanDetail[];
  batch: BatchDetail | null;
};

type PlanningFields = {
  displayName: string;
  outputRequirement: string;
  generationMode: "standard" | "fast";
  generationPreferences: FeedbackGenerationPreferences;
  studentSelections: Array<{ classId: string; studentIds: string[] }>;
  classOverrides: Array<{ classId: string; outputRequirement?: string; generationPreferences?: FeedbackGenerationPreferences }>;
  studentOverrides: Array<{ studentId: string; generationConfig: FeedbackPlanItemGenerationConfig }>;
};

type Props = {
  view: "intake" | "plan";
  planId: string;
  batchId: string;
  onPlan: () => void;
  onStudio: () => void;
  onSaveHandlerChange: (handler: (() => Promise<boolean>) | null) => void;
  onDocumentResolved: (target: FeedbackStudioPlanTarget & { batchId: string }) => void;
  onTaskChanged: (target: FeedbackStudioPlanTarget & { batchId: string }) => void;
  onPlanChanged: () => void;
  onContinueIntake: (seed: FeedbackTaskCurrentFactsSeed) => void;
};

const closureLabels: Record<string, string> = {
  informational: "知情型",
  positive_recognition: "具体认可",
  teacher_resolved: "课堂已处理",
  home_cooperation: "家庭配合",
  continued_observation: "后续观察",
};

const moduleLabels: Record<string, string> = {
  lesson_scope: "本课内容", key_difficulty: "关键难点", class_handling: "班级处理", homework_review: "作业与复习", next_lesson_link: "下次课衔接",
  observed_moment: "具体表现", teacher_interpretation: "教师判断", teacher_intervention: "老师已经做了什么", intervention_outcome: "处理结果", parent_action: "家长最低动作", followup_observation: "后续观察",
  starting_point: "阶段起点", recent_trend: "近期趋势", stable_capability: "已稳定能力", unresolved_issue: "尚未稳定问题", teacher_support: "阶段内教师支持", next_stage_focus: "下一阶段重点",
  starting_state: "起点状态", evidence_backed_change: "有证据的变化", remaining_gap: "剩余断点", next_stage_learning_path: "下一阶段学习路径",
};

const typeLabels: Record<FeedbackPlanType, string> = {
  class_update: "班级公共反馈",
  event_micro: "事件型微反馈",
  stage_trend: "阶段趋势反馈",
  course_end: "结课教学总结",
};

const lengthLabels: Record<string, string> = { inherit: "随家庭偏好", short: "简洁", standard: "标准", detailed: "详细" };
const toneLabels: Record<string, string> = { inherit: "随现有偏好", gentle: "温和", professional: "专业" };

const resolutionActionLabels: Record<string, string> = {
  ignore_source: "未采用材料",
  accept_source: "确认采用材料",
  bind_student: "已绑定学生",
  accept_observation: "已确认观察",
  ignore_observation: "未采用观察",
  accept_assessment: "已确认测评",
  ignore_assessment: "未采用测评",
};

function parsePlanInput(plan: PlanDetail): PlanInput {
  if (plan.input && typeof plan.input === "object") return plan.input;
  try {
    const parsed = JSON.parse(plan.inputSnapshot ?? "null") as PlanInput | null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function materialText(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 240 ? `${normalized.slice(0, 240)}…` : normalized;
}

function materialSnapshot(material: LessonFeedbackMaterial | undefined) {
  const lines = [
    ["课程标题", material?.lessonTitle ?? ""],
    ["内容摘要", material?.lessonSummary ?? ""],
    ["课堂内容", material?.classroomContent.join("；") ?? ""],
    ["重点与难点", material?.classroomFocus.join("；") ?? ""],
    ["课堂说明", material?.classroomExplanation.join("；") ?? ""],
    ["作业", material?.homework.join("；") ?? ""],
    ["测评重点", material?.assessmentFocus.join("；") ?? ""],
    ["订正建议", material?.correctionAdvice.join("；") ?? ""],
    ["其他说明", material?.otherNotes.join("；") ?? ""],
    ["班级反馈素材", material?.groupFeedbackRaw ?? ""],
    ["测评说明", material?.assessmentBriefRaw ?? ""],
  ].flatMap(([label, value]) => {
    const text = materialText(value);
    return text ? [{ label, text }] : [];
  });
  const source = material?.semesterScriptSource
    ? `材料库第 ${material.semesterScriptSource.lessonNumber} 课快照`
    : material?.scriptLessonNumber
      ? `第 ${material.scriptLessonNumber} 课材料快照`
      : material?.sessionCode
        ? `${material.sessionCode} 课次材料快照`
        : "课次公共课程材料快照";
  return { used: lines.length > 0, source, lines };
}

function commonPreferences(plans: PlanDetail[]) {
  const frozenBatchDefault = plans
    .map((plan) => parsePlanInput(plan).batchGenerationPreferences)
    .find((value): value is FeedbackGenerationPreferences => Boolean(value));
  if (frozenBatchDefault) return frozenBatchDefault;
  const values = plans.map((plan) => parsePlanInput(plan).generationPreferences ?? defaultFeedbackGenerationPreferences(plan.type));
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = JSON.stringify(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const mostCommon = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  return mostCommon ? JSON.parse(mostCommon) as FeedbackGenerationPreferences : defaultFeedbackGenerationPreferences(plans[0]?.type ?? "event_micro");
}

function planningFields(document: LoadedDocument): PlanningFields {
  const common = commonPreferences(document.plans);
  const commonRequirement = document.batch?.outputRequirement ?? document.plan.outputRequirement;
  const displayName = document.batch?.displayName ?? document.plan.displayName
    ?? `${document.plans.length > 1 ? "班级组" : document.plan.class?.name ?? document.plan.class?.code ?? "反馈"} · ${document.plan.session?.code ?? document.plan.rangeEndSession?.code ?? "历史计划"}`;
  return {
    displayName: (document.batch?.basedOnBatchId || document.plan.basedOnPlanId) && !(document.batch?.displayName ?? document.plan.displayName)
      ? ""
      : displayName,
    outputRequirement: commonRequirement,
    generationMode: document.batch?.generationMode ?? document.plan.generationMode ?? "standard",
    generationPreferences: {
      ...common,
      length: common.length ?? "inherit",
      tone: common.tone ?? "inherit",
      moduleKeys: [...common.moduleKeys],
    },
    studentSelections: document.plans.map((plan) => ({
      classId: plan.class?.id ?? "",
      studentIds: parsePlanInput(plan).selectedStudentIds ?? plan.items.flatMap((item) => item.studentId ? [item.studentId] : []),
    })).filter((selection) => selection.classId),
    classOverrides: document.kind === "batch" ? document.plans.flatMap((plan) => {
      const preferences = parsePlanInput(plan).generationPreferences ?? defaultFeedbackGenerationPreferences(plan.type);
      const outputRequirement = plan.outputRequirement !== commonRequirement ? plan.outputRequirement : undefined;
      const generationPreferences = JSON.stringify(preferences) !== JSON.stringify(common) ? preferences : undefined;
      return outputRequirement || generationPreferences ? [{ classId: plan.class?.id ?? "", outputRequirement, generationPreferences }] : [];
    }).filter((item) => item.classId) : [],
    studentOverrides: document.plans.flatMap((plan) => parsePlanInput(plan).studentOverrides ?? plan.items.flatMap((item) => (
      item.studentId && item.generationConfig ? [{ studentId: item.studentId, generationConfig: item.generationConfig }] : []
    ))),
  };
}

function fingerprint(fields: PlanningFields) {
  return JSON.stringify(fields);
}

function documentStatus(document: LoadedDocument) {
  return document.batch?.status ?? document.plan.status;
}

const generatedPlanStatuses = new Set([
  "queued", "generating", "pause_requested", "paused", "generation_failed",
  "in_review", "partially_approved", "approved", "partially_exported", "exported",
]);

function planHasGenerationTrace(plan: PlanDetail) {
  return Boolean(plan.generationStartedAt || plan.generationCompletedAt)
    || generatedPlanStatuses.has(plan.status)
    || plan.items.some((item) => (
      Boolean(item.finalText || item.selectedGenerationId || item.approvedAt || item.exportedAt)
      || ["queued", "generating", "pause_requested", "paused", "generation_failed", "needs_review", "approved", "exported"].includes(item.status)
    ));
}

function documentGenerationComplete(document: LoadedDocument) {
  const items = document.plans.flatMap((plan) => plan.items);
  return items.length > 0 && items.every((item) => ["needs_review", "approved", "exported"].includes(item.status));
}

export function FeedbackFactFreezeIndicator({ complete }: { complete: boolean }) {
  const label = complete ? "已完成反馈生成 · 事实已冻结" : "未完成反馈生成 · 事实已冻结";
  return <span
    className={`${styles.factFreezeIndicator} ${complete ? styles.factFreezeComplete : styles.factFreezeIncomplete}`}
    role="status"
    aria-label={label}
  >
    <span className={styles.factFreezeSignal} aria-hidden="true" />
    <span>{label}</span>
  </span>;
}

function documentIsEditable(document: LoadedDocument) {
  if (document.kind === "batch") {
    const status = documentStatus(document);
    return (status === "draft" || status === "ready")
      && document.plans.every((plan) => !planHasGenerationTrace(plan) && !plan.archivedAt);
  }
  return !planHasGenerationTrace(document.plan) && !document.plan.archivedAt;
}

function documentRevision(document: LoadedDocument) {
  return document.batch?.planRevision ?? document.plan.planRevision ?? 1;
}

function documentKey(document: LoadedDocument) {
  return document.kind === "batch" ? `batch:${document.batch!.id}` : `plan:${document.plan.id}`;
}

function requestedDocumentKey(planId: string, batchId: string) {
  return batchId ? `batch:${batchId}` : planId ? `plan:${planId}` : "";
}

async function loadDocument(planId: string, batchId: string): Promise<LoadedDocument> {
  if (batchId) {
    const { batch } = await requestJson<{ batch: BatchDetail }>(`/api/report/feedback-plan-batches/${encodeURIComponent(batchId)}`);
    const details = await Promise.all(batch.plans.map(({ id }) => requestJson<{ plan: PlanDetail }>(`/api/report/feedback-plans/${encodeURIComponent(id)}`)));
    const plans = details.map((item) => item.plan);
    const plan = plans.find((item) => item.id === planId) ?? plans[0];
    if (!plan) throw new Error("班级组中没有可查看的反馈计划");
    return { kind: "batch", plan, plans, batch };
  }
  const { plan } = await requestJson<{ plan: PlanDetail }>(`/api/report/feedback-plans/${encodeURIComponent(planId)}`);
  return { kind: "plan", plan, plans: [plan], batch: null };
}

export function FeedbackTaskDocumentStage(props: Props) {
  const { onDocumentResolved, onPlanChanged, onSaveHandlerChange } = props;
  const [document, setDocument] = useState<LoadedDocument | null>(null);
  const [fields, setFields] = useState<PlanningFields | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [studentTarget, setStudentTarget] = useState<{ plan: PlanDetail; studentId: string; studentName: string } | null>(null);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [continueIntakeOpen, setContinueIntakeOpen] = useState(false);
  const savedFingerprint = useRef("");
  const fieldsRef = useRef<PlanningFields | null>(null);
  const documentRef = useRef<LoadedDocument | null>(null);
  const loadSequence = useRef(0);
  const savePromise = useRef<Promise<boolean> | null>(null);
  const failedSaveFingerprint = useRef("");
  const actionBusyRef = useRef(false);
  const requestedKey = requestedDocumentKey(props.planId, props.batchId);
  const requestedKeyRef = useRef(requestedKey);
  useLayoutEffect(() => { requestedKeyRef.current = requestedKey; }, [requestedKey]);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const loadKey = requestedDocumentKey(props.planId, props.batchId);
    if (!loadKey) {
      setLoading(false);
      return;
    }
    setLoading(true); setActionError("");
    try {
      const next = await loadDocument(props.planId, props.batchId);
      if (sequence !== loadSequence.current || requestedKeyRef.current !== loadKey) return;
      const nextFields = planningFields(next);
      documentRef.current = next;
      fieldsRef.current = nextFields;
      savedFingerprint.current = fingerprint(nextFields);
      failedSaveFingerprint.current = "";
      setSavedValue(savedFingerprint.current);
      setDocument(next);
      setFields(nextFields);
      setSaveError("");
      if (props.batchId && !props.planId) {
        onDocumentResolved({
          id: next.plan.id,
          batchId: props.batchId,
          classId: next.plan.class?.id ?? "",
          className: next.plan.class?.name ?? next.plan.class?.code ?? "",
          sessionCode: next.plan.session?.code ?? next.plan.rangeEndSession?.code ?? "",
        });
      }
    } catch (reason) {
      if (sequence === loadSequence.current && requestedKeyRef.current === loadKey) {
        setActionError(reason instanceof Error ? reason.message : "读取反馈计划失败");
      }
    } finally {
      if (sequence === loadSequence.current && requestedKeyRef.current === loadKey) setLoading(false);
    }
  }, [onDocumentResolved, props.batchId, props.planId]);

  useEffect(() => {
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);
  useEffect(() => { fieldsRef.current = fields; }, [fields]);
  useEffect(() => { documentRef.current = document; }, [document]);

  const dirty = Boolean(fields && fingerprint(fields) !== savedValue);
  const editable = Boolean(document && documentIsEditable(document));
  const requiresName = Boolean(fields && !fields.displayName.trim());

  const ensureNamedFields = useCallback((current: PlanningFields, promptForName: boolean) => {
    if (current.displayName.trim()) return current;
    if (!promptForName) return current;
    setActionError("请先填写计划名称，再保存当前草稿。");
    return null;
  }, []);

  const save = useCallback(function persistPlan(options: { requireName?: boolean; automatic?: boolean } = {}): Promise<boolean> {
    if (savePromise.current) {
      const pending = savePromise.current;
      if (!options.requireName) return pending;
      return pending.then((saved) => saved ? persistPlan(options) : false);
    }
    const operation = (async () => {
      const currentDocument = documentRef.current;
      const currentFields = fieldsRef.current;
      if (!currentDocument || !currentFields || documentKey(currentDocument) !== requestedKeyRef.current) return false;
      const canEditPlan = documentIsEditable(currentDocument);
      if (!canEditPlan) {
        if (fingerprint(currentFields) === savedFingerprint.current) return true;
        setSaveAsName(`${currentFields.displayName || "反馈计划"} 修订版`);
        setSaveAsOpen(true);
        return false;
      }
      const namedFields = ensureNamedFields(currentFields, options.requireName === true);
      if (!namedFields) return false;
      const startedFingerprint = fingerprint(namedFields);
      if (startedFingerprint === savedFingerprint.current) return true;
      if (!namedFields.displayName.trim()) {
        if (options.automatic) failedSaveFingerprint.current = startedFingerprint;
        return false;
      }
      setSaving(true); setSaveError("");
      const currentKey = documentKey(currentDocument);
      const expectedPlanRevision = documentRevision(currentDocument);
      let savedPlan: PlanDetail | null = null;
      let savedBatch: BatchDetail | null = null;
      try {
        if (currentDocument.kind === "batch") {
          const body = canEditPlan ? {
            action: "plan_draft",
            expectedPlanRevision,
            ...(namedFields.displayName.trim() ? { displayName: namedFields.displayName.trim() } : {}),
            outputRequirement: namedFields.outputRequirement,
            generationMode: namedFields.generationMode,
            generationPreferences: namedFields.generationPreferences,
            studentSelections: namedFields.studentSelections,
            classOverrides: namedFields.classOverrides,
            studentOverrides: namedFields.studentOverrides,
          } : { action: "rename", displayName: namedFields.displayName.trim(), expectedPlanRevision };
          const result = await requestJson<{ batch: BatchDetail }>(`/api/report/feedback-plan-batches/${encodeURIComponent(currentDocument.batch!.id)}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
          savedBatch = result.batch;
        } else {
          const body = canEditPlan ? {
            action: "plan_draft",
            patch: {
              ...(namedFields.displayName.trim() ? { displayName: namedFields.displayName.trim() } : {}),
              outputRequirement: namedFields.outputRequirement,
              generationMode: namedFields.generationMode,
              generationPreferences: namedFields.generationPreferences,
              studentIds: namedFields.studentSelections[0]?.studentIds ?? currentDocument.plan.items.flatMap((item) => item.studentId ? [item.studentId] : []),
              studentOverrides: namedFields.studentOverrides,
              expectedPlanRevision,
            },
          } : { action: "rename", displayName: namedFields.displayName.trim(), expectedPlanRevision };
          const result = await requestJson<{ plan: PlanDetail }>(`/api/report/feedback-plans/${encodeURIComponent(currentDocument.plan.id)}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          });
          savedPlan = result.plan;
        }
        failedSaveFingerprint.current = "";
        onPlanChanged();
        if (requestedKeyRef.current !== currentKey) return true;

        let fresh: LoadedDocument;
        let refreshFailed = false;
        try {
          fresh = await loadDocument(currentDocument.plan.id, currentDocument.batch?.id ?? "");
        } catch {
          refreshFailed = true;
          if (savedPlan) {
            fresh = { kind: "plan", plan: savedPlan, plans: [savedPlan], batch: null };
          } else {
            const batch = savedBatch ?? {
              ...currentDocument.batch!,
              planRevision: expectedPlanRevision + 1,
              displayName: namedFields.displayName.trim() || currentDocument.batch!.displayName,
            };
            fresh = { ...currentDocument, batch };
          }
        }
        if (requestedKeyRef.current !== currentKey) return true;
        const freshFields = refreshFailed && currentDocument.kind === "batch"
          ? { ...namedFields, displayName: fresh.batch?.displayName ?? namedFields.displayName }
          : planningFields(fresh);
        documentRef.current = fresh;
        setDocument(fresh);
        savedFingerprint.current = fingerprint(freshFields);
        setSavedValue(savedFingerprint.current);
        if (fingerprint(fieldsRef.current ?? namedFields) === startedFingerprint) {
          fieldsRef.current = freshFields;
          setFields(freshFields);
        }
        setNotice(refreshFailed
          ? "计划已保存；最新详情暂时无法刷新，后续保存仍可继续。"
          : options.automatic ? "计划已自动保存。" : "计划已保存。");
        return true;
      } catch (reason) {
        failedSaveFingerprint.current = startedFingerprint;
        if (requestedKeyRef.current === currentKey) {
          setSaveError(reason instanceof Error ? reason.message : "保存失败，当前修改仍保留在页面中");
        }
        return false;
      }
    })();
    savePromise.current = operation;
    void operation.finally(() => {
      if (savePromise.current === operation) savePromise.current = null;
      setSaving(false);
    });
    return operation;
  }, [ensureNamedFields, onPlanChanged]);

  useEffect(() => {
    if (!document || !fields || !editable || !dirty || failedSaveFingerprint.current === fingerprint(fields)) return;
    const timer = window.setTimeout(() => void save({ automatic: true }), 800);
    return () => window.clearTimeout(timer);
  }, [dirty, document, editable, fields, save]);

  useEffect(() => {
    onSaveHandlerChange(() => save({ requireName: true }));
    return () => onSaveHandlerChange(null);
  }, [onSaveHandlerChange, save]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      const currentDocument = documentRef.current;
      if (currentDocument && !documentIsEditable(currentDocument)) {
        setSaveAsName(`${fieldsRef.current?.displayName || "反馈计划"} 修订版`);
        setSaveAsOpen(true);
      } else void save({ requireName: true });
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!fieldsRef.current || fingerprint(fieldsRef.current) === savedFingerprint.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("beforeunload", onBeforeUnload); };
  }, [save]);

  const candidateStudents = useMemo(() => document?.plans.flatMap((plan) => {
    const input = parsePlanInput(plan);
    const factStudentIds = input.factSnapshot?.items.flatMap((item) => item.studentId ? [item.studentId] : []) ?? [];
    const ids = [...new Set([...factStudentIds, ...plan.items.flatMap((item) => item.studentId ? [item.studentId] : [])])];
    return ids.map((studentId) => {
      const item = plan.items.find((candidate) => candidate.studentId === studentId);
      const fact = input.factSnapshot?.items.find((candidate) => candidate.studentId === studentId);
      return {
        key: `${plan.id}:${studentId}`,
        plan,
        studentId,
        classId: plan.class?.id ?? "",
        className: plan.class?.name ?? plan.class?.code ?? "当前班级",
        name: item?.student?.name ?? fact?.studentName ?? "学生",
        publicStudentId: item?.student?.studentId ?? fact?.studentNumber ?? "",
        independent: fields?.studentOverrides.some((override) => override.studentId === studentId) ?? false,
      };
    });
  }) ?? [], [document, fields?.studentOverrides]);

  if (loading) return <StatusBanner tone="info">正在读取计划文档…</StatusBanner>;
  if (!document || !fields) return <StatusBanner tone="danger"><span>{actionError || "反馈计划不存在"}</span><Button uiSize="sm" variant="secondary" onClick={() => void load()}>重试</Button></StatusBanner>;

  const status = documentStatus(document);
  const inputs = document.plans.map((plan) => ({ plan, input: parsePlanInput(plan) }));
  const intakeSources = inputs.flatMap(({ plan, input }) => (input.intakeSources ?? []).map((source) => ({ plan, source })));
  const facts = inputs.flatMap(({ plan, input }) => (input.factSnapshot?.items ?? []).map((fact) => ({ plan, fact, capturedAt: input.factSnapshot?.capturedAt })));
  const materials = inputs.map(({ plan, input }) => ({ plan, ...materialSnapshot(input.lessonMaterial) }));
  const generationComplete = documentGenerationComplete(document);

  function cloneDraft() {
    setSaveAsName(`${fieldsRef.current?.displayName || "反馈计划"} 修订版`);
    setSaveAsOpen(true);
  }

  function discardWorkingCopy() {
    const currentDocument = documentRef.current;
    if (!currentDocument) return;
    const baseline = planningFields(currentDocument);
    fieldsRef.current = baseline;
    setFields(baseline);
    setSavedValue(fingerprint(baseline));
    savedFingerprint.current = fingerprint(baseline);
    setSaveAsOpen(false);
    setActionError("");
    setNotice("已放弃页面工作副本；源计划没有变化。");
  }

  async function saveAsCopy() {
    const currentDocument = documentRef.current;
    const currentFields = fieldsRef.current;
    const displayName = saveAsName.trim();
    if (!currentDocument || !currentFields || !displayName || actionBusyRef.current) return;
    actionBusyRef.current = true; setActionBusy(true); setActionError("");
    try {
      if (currentDocument.kind === "batch") {
        const patch = {
          action: "plan_draft",
          expectedPlanRevision: documentRevision(currentDocument),
          displayName,
          outputRequirement: currentFields.outputRequirement,
          generationMode: currentFields.generationMode,
          generationPreferences: currentFields.generationPreferences,
          studentSelections: currentFields.studentSelections,
          classOverrides: currentFields.classOverrides,
          studentOverrides: currentFields.studentOverrides,
        };
        const { batch } = await requestJson<{ batch: BatchDetail }>(`/api/report/feedback-plan-batches/${encodeURIComponent(currentDocument.batch!.id)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_as", displayName, patch }),
        });
        const first = batch.plans[0];
        if (!first) throw new Error("新计划没有可打开的班级");
        setSaveAsOpen(false);
        props.onPlanChanged();
        props.onTaskChanged({ id: first.id, batchId: batch.id, classId: first.class.id, className: first.class.name ?? first.class.code, sessionCode: first.session?.code ?? first.rangeEndSession?.code ?? "" });
      } else {
        const patch = {
          displayName,
          outputRequirement: currentFields.outputRequirement,
          generationMode: currentFields.generationMode,
          generationPreferences: currentFields.generationPreferences,
          studentIds: currentFields.studentSelections[0]?.studentIds ?? [],
          studentOverrides: currentFields.studentOverrides,
        };
        const { plan } = await requestJson<{ plan: PlanDetail }>(`/api/report/feedback-plans/${encodeURIComponent(currentDocument.plan.id)}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_as", displayName, expectedPlanRevision: documentRevision(currentDocument), patch }),
        });
        setSaveAsOpen(false);
        props.onPlanChanged();
        props.onTaskChanged({ id: plan.id, batchId: "", classId: plan.class?.id ?? "", className: plan.class?.name ?? plan.class?.code ?? "", sessionCode: plan.session?.code ?? plan.rangeEndSession?.code ?? "" });
      }
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "另存计划失败");
    } finally {
      actionBusyRef.current = false; setActionBusy(false);
    }
  }

  async function renameCurrent() {
    const currentDocument = documentRef.current;
    const currentFields = fieldsRef.current;
    if (!currentDocument || !currentFields?.displayName.trim() || actionBusyRef.current) return;
    actionBusyRef.current = true; setActionBusy(true); setActionError("");
    try {
      const path = currentDocument.kind === "batch"
        ? `/api/report/feedback-plan-batches/${encodeURIComponent(currentDocument.batch!.id)}`
        : `/api/report/feedback-plans/${encodeURIComponent(currentDocument.plan.id)}`;
      await requestJson(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", displayName: currentFields.displayName.trim(), expectedPlanRevision: documentRevision(currentDocument) }),
      });
      props.onPlanChanged();
      const fresh = await loadDocument(currentDocument.plan.id, currentDocument.batch?.id ?? "");
      const baseline = planningFields(fresh);
      documentRef.current = fresh; setDocument(fresh);
      savedFingerprint.current = fingerprint(baseline); setSavedValue(savedFingerprint.current);
      setFields({ ...currentFields, displayName: baseline.displayName });
      setNotice("计划已重命名；其他页面修改仍需另存为新计划。");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "重命名失败");
    } finally {
      actionBusyRef.current = false; setActionBusy(false);
    }
  }

  async function startGeneration() {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      if (!(await save({ requireName: true }))) return;
      const savedDocument = documentRef.current ?? document!;
      const expectedPlanRevision = documentRevision(savedDocument);
      if (savedDocument.kind === "batch") {
        await requestJson(`/api/report/feedback-plan-batches/${encodeURIComponent(savedDocument.batch!.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", expectedPlanRevision }) });
      } else {
        await requestJson(`/api/report/feedback-plans/${encodeURIComponent(savedDocument.plan.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start_generation", generationMode: fieldsRef.current?.generationMode ?? "standard", expectedPlanRevision }) });
      }
      props.onPlanChanged();
      props.onStudio();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "启动生成失败";
      await load();
      setActionError(message);
    } finally {
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  }

  function updateClassOverride(classId: string, patch: Partial<PlanningFields["classOverrides"][number]>) {
    const currentFields = fields!;
    const current = currentFields.classOverrides.find((override) => override.classId === classId);
    const next = {
      classId,
      outputRequirement: patch.outputRequirement ?? current?.outputRequirement,
      generationPreferences: patch.generationPreferences ?? current?.generationPreferences,
    };
    setFields({ ...currentFields, classOverrides: [...currentFields.classOverrides.filter((override) => override.classId !== classId), next] });
  }

  function removeClassOverride(classId: string) {
    const currentFields = fields!;
    setFields({ ...currentFields, classOverrides: currentFields.classOverrides.filter((override) => override.classId !== classId) });
  }

  function toggleStudent(classId: string, studentId: string) {
    const currentFields = fields!;
    const current = currentFields.studentSelections.find((selection) => selection.classId === classId) ?? { classId, studentIds: [] };
    const selected = current.studentIds.includes(studentId);
    const nextIds = selected ? current.studentIds.filter((id) => id !== studentId) : [...current.studentIds, studentId];
    if (!nextIds.length) {
      setActionError("每个班至少保留一名反馈对象。");
      return;
    }
    setActionError("");
    setFields({
      ...currentFields,
      studentSelections: [...currentFields.studentSelections.filter((selection) => selection.classId !== classId), { classId, studentIds: nextIds }],
      studentOverrides: selected ? currentFields.studentOverrides.filter((override) => override.studentId !== studentId) : currentFields.studentOverrides,
    });
  }

  function inheritedStudentConfig(plan: PlanDetail): FeedbackPlanItemGenerationConfig {
    const currentFields = fields!;
    const classOverride = currentFields.classOverrides.find((override) => override.classId === plan.class?.id);
    return {
      version: 1,
      type: plan.type,
      outputRequirement: classOverride?.outputRequirement ?? currentFields.outputRequirement,
      generationPreferences: classOverride?.generationPreferences ?? currentFields.generationPreferences,
    };
  }

  function continueWithCurrentFacts() {
    const currentDocument = document;
    const currentFields = fields;
    if (!currentDocument || !currentFields) return;
    const entries = currentDocument.plans.flatMap((plan) => {
      const classId = plan.class?.id;
      const sessionCode = plan.session?.code ?? plan.rangeEndSession?.code;
      if (!classId || !sessionCode) return [];
      const selection = currentFields.studentSelections.find((item) => item.classId === classId);
      return [{
        classId,
        classCode: plan.class?.code ?? "",
        className: plan.class?.name ?? plan.class?.code ?? "当前班级",
        sessionCode,
        ...(plan.rangeStartSession?.id ? { rangeStartSessionId: plan.rangeStartSession.id } : {}),
        ...(plan.rangeEndSession?.id ? { rangeEndSessionId: plan.rangeEndSession.id } : {}),
        runId: "",
        studentIds: selection?.studentIds ?? plan.items.flatMap((item) => item.studentId ? [item.studentId] : []),
        studentSelectionInitialized: currentDocument.plan.type !== "class_update",
        selected: true,
      }];
    });
    if (!entries.length) {
      setActionError("当前计划没有可继续录入的真实班级和课次。");
      return;
    }
    const sharedRevisionId = currentDocument.batch?.sharedLessonRevision?.id;
    const preferences: FeedbackTaskPreferences = {
      ...currentFields.generationPreferences,
      length: currentFields.generationPreferences.length ?? "inherit",
      tone: currentFields.generationPreferences.tone ?? "inherit",
      moduleKeys: [...currentFields.generationPreferences.moduleKeys],
    };
    props.onContinueIntake({
      revisionSource: currentDocument.kind === "batch"
        ? { kind: "batch", batchId: currentDocument.batch!.id, type: currentDocument.batch!.type }
        : { kind: "plan", planId: currentDocument.plan.id, type: currentDocument.plan.type },
      displayName: "",
      mode: currentDocument.kind === "batch" ? "group" : "single",
      groupLessonId: currentDocument.batch?.sharedLessonRevision?.groupLesson.id
        ?? currentDocument.batch?.plans[0]?.session?.groupLessonSession?.groupLessonId
        ?? currentDocument.batch?.plans[0]?.rangeEndSession?.groupLessonSession?.groupLessonId
        ?? "",
      activeSessionCode: currentDocument.plan.session?.code ?? currentDocument.plan.rangeEndSession?.code ?? entries[0]!.sessionCode,
      entries,
      materialSelection: sharedRevisionId ? { mode: "linked_revision", revisionId: sharedRevisionId } : { mode: "none" },
      materialSelectionInitialized: Boolean(sharedRevisionId),
      generationMode: currentFields.generationMode,
      outputRequirement: currentFields.outputRequirement,
      preferences,
      classOverrides: currentDocument.plans.flatMap((plan) => {
        const classId = plan.class?.id;
        const sessionCode = plan.session?.code ?? plan.rangeEndSession?.code;
        const override = classId ? currentFields.classOverrides.find((item) => item.classId === classId) : undefined;
        if (!override || !sessionCode) return [];
        return [{
          sessionCode,
          ...(override.outputRequirement ? { outputRequirement: override.outputRequirement } : {}),
          ...(override.generationPreferences ? { preferences: { ...override.generationPreferences, moduleKeys: [...override.generationPreferences.moduleKeys] } } : {}),
        }];
      }),
      studentOverrides: currentFields.studentOverrides.map((override) => ({
        studentId: override.studentId,
        generationConfig: override.generationConfig,
      })),
    });
  }

  if (props.view === "intake") return <div className={styles.documentStage}>
    {actionError && <StatusBanner tone="danger">{actionError}</StatusBanner>}
    <section className={styles.documentHeading}><div><h2>{fields.displayName}</h2><p>这里回看的是建立本计划时采用的事实和材料，不会随着事实库后来修改而变化。</p></div><aside className={styles.documentHeadingActions}><FeedbackFactFreezeIndicator complete={generationComplete} /><Button variant="secondary" onClick={() => setContinueIntakeOpen(true)}>继续录入事实</Button></aside></section>
    <section className={styles.materialGuide}><strong>建立反馈可使用哪些材料？</strong><p>真实班级与课次是归属基础；助教 Excel、STEP 报告、测评 PDF / ZIP 和公共课程材料都可按需提供。文件不是必填项，教师确认事实才是进入规划的必要门槛。</p></section>
    <section className={styles.frozenFacts}><header><div><strong>采用的公共课程材料</strong><span>按计划建立时的快照展示；后来修改材料库不会覆盖这里。</span></div></header>{materials.map(({ plan, used, source, lines }) => <details key={`material:${plan.id}`} open={materials.length === 1 && used}><summary><span><strong>{plan.class?.name ?? plan.class?.code ?? "当前班级"}</strong><small>{used ? `${source}${plan.session?.code || plan.rangeEndSession?.code ? ` · ${plan.session?.code ?? plan.rangeEndSession?.code}` : ""}` : "未使用公共课程材料"}</small></span><span>{used ? `${lines.length} 项` : "未采用"}</span></summary>{used ? <ul>{lines.map((line) => <li key={line.label}><strong>{line.label}：</strong>{line.text}</li>)}</ul> : <p className={styles.materialSnapshotEmpty}>本计划没有采用公共课程材料快照；仍可依据已确认的课堂事实和测评证据生成。</p>}</details>)}</section>
    {intakeSources.length ? <section className={styles.snapshotGrid}>{intakeSources.map(({ plan, source }) => <article key={`${plan.id}:${source.intakeRunId}`}><header><div><strong>{plan.class?.name ?? plan.class?.code ?? "当前班级"}</strong><span>{source.sessionCode} · {source.confirmedAt ? `确认于 ${new Date(source.confirmedAt).toLocaleString("zh-CN")}` : "历史记录未保存确认时间"}</span></div><span>{source.status}</span></header><p>读取 {source.sourceCount} 份 · 识别 {source.recognizedCount} 份 · 忽略 {source.ignoredCount} 份 · 异常 {source.issueCount} 项</p>{source.resolvedDecisionCount !== undefined && <p>已处理 {source.resolvedDecisionCount} 项异常判断</p>}<ul>{source.sources.map((item, index) => <li key={`${item.name}:${index}`}><strong>{item.name}</strong><span>{item.kind}</span></li>)}</ul>{Boolean(source.resolutions?.length) && <details><summary>查看异常处理结果</summary><ul>{source.resolutions!.map((item, index) => <li key={`${item.action}:${item.sourceName ?? ""}:${index}`}><strong>{resolutionActionLabels[item.action] ?? "已处理"}</strong>{item.sourceName ? ` · ${item.sourceName}` : ""}{item.detail ? `：${item.detail}` : ""}</li>)}</ul></details>}</article>)}</section> : <StatusBanner tone="info">这是兼容的历史计划，没有保存可展示的录入来源摘要；计划正文和证据快照仍可继续查看。</StatusBanner>}
    <section className={styles.frozenFacts}><header><div><strong>已冻结事实</strong><span>{facts.length} 个反馈对象的计划证据快照</span></div></header>{facts.length ? facts.map(({ plan, fact, capturedAt }, index) => { const student = plan.items.find((item) => item.studentId === fact.studentId)?.student; const evidence = [...(fact.evidence.teachingEvidence ?? []), ...(fact.evidence.assessmentEvidence ?? [])].filter((item) => item.confirmed !== false); return <details key={`${plan.id}:${fact.studentId ?? index}`}><summary><span><strong>{student?.name ?? fact.studentName ?? "班级公共事实"}</strong><small>{plan.class?.name ?? plan.class?.code ?? "当前班级"}{student?.studentId || fact.studentNumber ? ` · ${student?.studentId ?? fact.studentNumber}` : ""} · {capturedAt ? `快照 ${new Date(capturedAt).toLocaleString("zh-CN")}` : "历史快照"}</small></span><span>{evidence.length} 条已确认事实</span></summary><ul>{evidence.map((item) => <li key={item.id}>{item.content}</li>)}</ul></details>; }) : <p>历史计划未保存 V2 事实总览；可在生成页逐条查看原有证据。</p>}</section>
    <div className={styles.documentFooterActions}>{editable ? <Button onClick={props.onPlan}>返回编辑计划</Button> : <><Button variant="ghost" onClick={cloneDraft} disabled={saving || actionBusy}>沿用冻结事实修正计划</Button><Button onClick={props.onStudio} disabled={actionBusy}>返回生成与复核</Button></>}</div>
    <Dialog open={continueIntakeOpen} title="继续录入事实" onClose={() => setContinueIntakeOpen(false)}><div className="dialog-form"><StatusBanner tone="warning">事实已冻结，如需修改，请谨慎录入新事实并新建计划。</StatusBanner><p className="dialog-form__hint">这会开启独立录入，不修改当前计划、正文、批准或导出记录。</p><div className="dialog-form__actions"><Button variant="secondary" onClick={() => setContinueIntakeOpen(false)}>取消</Button><Button onClick={() => { setContinueIntakeOpen(false); continueWithCurrentFacts(); }}>确认并继续录入</Button></div></div></Dialog>
  </div>;

  const frozen = !editable;
  const readOnly = false;
  return <div className={styles.documentStage}>
    <section className={styles.documentHeading}><div><span className={styles.eyebrow}>{frozen ? "计划总览 · 源计划已冻结" : "计划草稿 · 自动保存"}</span><h2>{fields.displayName || "未命名修正计划"}</h2><p>{frozen ? "可以直接试改范围与设置，但只能另存为新计划；原计划和结果不会被覆盖。" : "像文档一样随改随存；也可以点击保存或按 Ctrl/⌘ S。"}</p></div><span className={styles.documentStatus}>{status}</span></section>
    {saveError && <StatusBanner tone="danger"><span>{saveError}；页面中的修改仍然保留。</span><Button uiSize="sm" variant="secondary" onClick={() => void save({ requireName: true })}>重试保存</Button></StatusBanner>}
    {actionError && <StatusBanner tone="danger">{actionError}</StatusBanner>}
    {notice && !saveError && <StatusBanner tone="success">{notice}</StatusBanner>}
    <section className={styles.planDocumentHeader} aria-label="反馈计划名称与保存状态"><label><span>计划名称</span><input aria-label="计划名称" value={fields.displayName} maxLength={120} onChange={(event) => setFields({ ...fields, displayName: event.target.value })} placeholder="请输入一眼能认出的计划名称" /></label><div><span role="status">{frozen ? dirty ? "页面工作副本 · 原计划不可覆盖" : "源计划已冻结" : saving ? "保存中…" : requiresName ? "计划需要名称" : dirty ? "有未保存修改" : "已保存"}</span>{frozen ? <><Button uiSize="sm" variant="ghost" onClick={() => void renameCurrent()} disabled={actionBusy || !fields.displayName.trim()}>重命名</Button><Button uiSize="sm" variant="secondary" onClick={cloneDraft} disabled={actionBusy}>另存为…</Button></> : <Button uiSize="sm" variant="secondary" onClick={() => void save({ requireName: true })} disabled={saving || (!dirty && !requiresName)}>{saving ? "保存中…" : requiresName ? "命名并保存" : dirty ? "保存" : "已保存"}</Button>}<kbd>Ctrl/⌘ S</kbd></div></section>
    <section className={styles.readonlyScopeSummary}><div><span>{document.kind === "batch" ? "班级组与课次" : "班级与课次"}</span><strong>{document.plans.map((plan) => `${plan.class?.name ?? plan.class?.code ?? "未绑定班级"} · ${plan.session?.code ?? plan.rangeEndSession?.code ?? "未绑定课次"}`).join("、")}</strong><small>{document.kind === "batch" ? `${document.plans.length} 个真实班级；事实、正文、批准和导出仍按班隔离。` : document.plan.type === "class_update" ? "1 条班级公共反馈；生成启动前可以调整统一要求。" : `${fields.studentSelections[0]?.studentIds.length ?? 0} 名反馈对象；生成启动前可以调整范围。`}</small></div></section>
    <section className={styles.strategy}>
      <div className={styles.strategyHeading}><div><strong>统一生成设置</strong><span>{frozen ? "当前修改只保留在页面工作副本，另存为后才会成为新草稿。" : "修改会自动保存到当前草稿。"}</span></div></div>
      <div className={styles.strategyRows}>
        <label>生成方式<select value={fields.generationMode} disabled={readOnly} onChange={(event) => setFields({ ...fields, generationMode: event.target.value as "standard" | "fast" })}><option value="standard">标准反馈</option><option value="fast">快速草稿</option></select></label>
        <label>结尾类型<select value={fields.generationPreferences.closureType} disabled={readOnly} onChange={(event) => setFields({ ...fields, generationPreferences: { ...fields.generationPreferences, closureType: event.target.value as FeedbackGenerationPreferences["closureType"] } })}>{FEEDBACK_CLOSURES_BY_TYPE[document.plan.type].map((value) => <option key={value} value={value}>{closureLabels[value] ?? value}</option>)}</select></label>
        <label>详略<select value={fields.generationPreferences.length ?? "inherit"} disabled={readOnly} onChange={(event) => setFields({ ...fields, generationPreferences: { ...fields.generationPreferences, length: event.target.value as FeedbackGenerationPreferences["length"] } })}><option value="inherit">随家庭偏好</option><option value="short">简洁</option><option value="standard">标准</option><option value="detailed">详细</option></select></label>
        <label>语气<select value={fields.generationPreferences.tone ?? "inherit"} disabled={readOnly} onChange={(event) => setFields({ ...fields, generationPreferences: { ...fields.generationPreferences, tone: event.target.value as FeedbackGenerationPreferences["tone"] } })}><option value="inherit">随现有偏好</option><option value="gentle">温和</option><option value="professional">专业</option></select></label>
        <label className={styles.requirement}>总体要求<Textarea rows={4} value={fields.outputRequirement} disabled={readOnly} onChange={(event) => setFields({ ...fields, outputRequirement: event.target.value })} /></label>
      </div>
      <fieldset className={styles.documentModules}><legend>生成模块</legend>{FEEDBACK_MODULES[document.plan.type].map((key) => { const checked = fields.generationPreferences.moduleKeys.includes(key); return <label key={key} className={checked ? styles.documentModuleSelected : ""}><input type="checkbox" checked={checked} disabled={readOnly} onChange={(event) => setFields({ ...fields, generationPreferences: { ...fields.generationPreferences, moduleKeys: event.target.checked ? [...new Set([...fields.generationPreferences.moduleKeys, key])] : fields.generationPreferences.moduleKeys.filter((item) => item !== key) } })} /><span>{moduleLabels[key] ?? key}</span></label>; })}</fieldset>
    </section>
    {document.kind === "batch" && <section className={styles.documentExceptions}><header><strong>班级例外</strong><span>{fields.classOverrides.length} 个班级使用独立要求或设置</span></header>{document.plans.map((plan) => { const classId = plan.class?.id ?? ""; const override = fields.classOverrides.find((item) => item.classId === classId); const preferences = override?.generationPreferences ?? fields.generationPreferences; return <details key={plan.id} open={Boolean(override)}><summary><span><strong>{plan.class?.name ?? plan.class?.code ?? "当前班级"}</strong><small>{override ? "已调整班级默认" : "跟随班级组默认"}</small></span><span>{readOnly ? "查看" : "调整"}</span></summary><div>{readOnly && override && <div className={styles.documentOverrideSummary}><span>结尾：{closureLabels[preferences.closureType] ?? preferences.closureType}</span><span>模块：{preferences.moduleKeys.map((key) => moduleLabels[key] ?? key).join("、") || "按类型默认"}</span></div>}<label>班级总体要求<Textarea rows={2} disabled={readOnly} value={override?.outputRequirement ?? fields.outputRequirement} onChange={(event) => updateClassOverride(classId, { outputRequirement: event.target.value })} /></label><label>班级详略<select disabled={readOnly} value={preferences.length ?? "inherit"} onChange={(event) => updateClassOverride(classId, { generationPreferences: { ...preferences, length: event.target.value as FeedbackGenerationPreferences["length"] } })}><option value="inherit">随家庭偏好</option><option value="short">简洁</option><option value="standard">标准</option><option value="detailed">详细</option></select></label><label>班级语气<select disabled={readOnly} value={preferences.tone ?? "inherit"} onChange={(event) => updateClassOverride(classId, { generationPreferences: { ...preferences, tone: event.target.value as FeedbackGenerationPreferences["tone"] } })}><option value="inherit">随现有偏好</option><option value="gentle">温和</option><option value="professional">专业</option></select></label>{override && !readOnly && <Button uiSize="sm" variant="ghost" onClick={() => removeClassOverride(classId)}>恢复班级组默认</Button>}</div></details>; })}</section>}
    {document.plan.type === "class_update" ? <section className={styles.documentStudents}><header><div><strong>班级公共反馈</strong><span>每个班生成一条公共内容</span></div></header><p>该计划读取班级范围内已确认的课堂事实，不拆成学生条目，也不设置学生例外。</p></section> : <section className={styles.documentStudents}><header><div><strong>学生范围与独立设置</strong><span>{fields.studentSelections.reduce((total, selection) => total + selection.studentIds.length, 0)} 名反馈对象 · {fields.studentOverrides.length} 名有独立设置</span></div></header><div>{candidateStudents.map((student) => { const selected = fields.studentSelections.find((selection) => selection.classId === student.classId)?.studentIds.includes(student.studentId) ?? false; const override = fields.studentOverrides.find((item) => item.studentId === student.studentId); return <article key={student.key} className={selected ? styles.documentStudentSelected : ""}><label><input type="checkbox" checked={selected} disabled={readOnly} onChange={() => toggleStudent(student.classId, student.studentId)} /><span><strong>{student.name}</strong><small>{student.className}{student.publicStudentId ? ` · ${student.publicStudentId}` : ""}</small></span></label>{readOnly && override ? <div className={styles.documentStudentOverride}><strong>{typeLabels[override.generationConfig.type]}</strong><span>{override.generationConfig.outputRequirement}</span><small>{closureLabels[override.generationConfig.generationPreferences.closureType] ?? override.generationConfig.generationPreferences.closureType} · {lengthLabels[override.generationConfig.generationPreferences.length ?? "inherit"]} · {toneLabels[override.generationConfig.generationPreferences.tone ?? "inherit"]}</small><small>{override.generationConfig.generationPreferences.moduleKeys.map((key) => moduleLabels[key] ?? key).join("、") || "按类型默认模块"}</small></div> : <span>{student.independent ? "独立设置" : "跟随默认"}</span>}{!readOnly && <Button uiSize="sm" variant="ghost" onClick={() => setStudentTarget({ plan: student.plan, studentId: student.studentId, studentName: student.name })}>{student.independent ? "调整设置" : "单独设置"}</Button>}</article>; })}</div></section>}
    <div className={styles.documentFooterActions}>{frozen ? <><Button variant="secondary" onClick={cloneDraft} disabled={saving || actionBusy}>另存为新计划…</Button><Button onClick={props.onStudio} disabled={actionBusy}>返回生成与复核</Button></> : <><Button variant="secondary" onClick={() => void save({ requireName: true })} disabled={saving || actionBusy || (!dirty && !requiresName)}>{requiresName ? "命名并保存计划" : "保存计划"}</Button><Button onClick={() => void startGeneration()} disabled={saving || actionBusy || !fields.outputRequirement.trim()}>{actionBusy ? "正在启动生成…" : "保存并开始生成"}</Button></>}</div>
    {studentTarget && <FeedbackPlanGenerationConfigDialog
      open
      studentName={studentTarget.studentName}
      initialConfig={independentConfigFromCommon(inheritedStudentConfig(studentTarget.plan), fields.studentOverrides.find((override) => override.studentId === studentTarget.studentId)?.generationConfig)}
      busy={saving}
      onClose={() => setStudentTarget(null)}
      onSave={async (generationConfig) => {
        const classId = studentTarget.plan.class?.id ?? "";
        const selection = fields.studentSelections.find((item) => item.classId === classId) ?? { classId, studentIds: [] };
        setFields({
          ...fields,
          studentSelections: selection.studentIds.includes(studentTarget.studentId) ? fields.studentSelections : [...fields.studentSelections.filter((item) => item.classId !== classId), { classId, studentIds: [...selection.studentIds, studentTarget.studentId] }],
          studentOverrides: [...fields.studentOverrides.filter((override) => override.studentId !== studentTarget.studentId), { studentId: studentTarget.studentId, generationConfig }],
        });
        setStudentTarget(null);
      }}
      onReset={fields.studentOverrides.some((override) => override.studentId === studentTarget.studentId) ? async () => {
        setFields({ ...fields, studentOverrides: fields.studentOverrides.filter((override) => override.studentId !== studentTarget.studentId) });
        setStudentTarget(null);
      } : undefined}
    />}
    <Dialog open={saveAsOpen} title="另存为新计划" onClose={() => { if (!actionBusy) setSaveAsOpen(false); }}><form className="dialog-form" onSubmit={(event) => { event.preventDefault(); void saveAsCopy(); }}><StatusBanner tone="info">新计划会沿用当前冻结事实和页面中的规划设置；原计划、正文、批准与导出记录都不会修改。</StatusBanner><label>新计划名称<Input autoFocus required maxLength={120} value={saveAsName} onChange={(event) => setSaveAsName(event.target.value)} /></label><div className="dialog-form__actions"><Button variant="ghost" onClick={discardWorkingCopy} disabled={actionBusy}>放弃页面修改</Button><Button variant="secondary" onClick={() => setSaveAsOpen(false)} disabled={actionBusy}>取消</Button><Button type="submit" disabled={actionBusy || !saveAsName.trim()}>{actionBusy ? "正在另存…" : "另存为新计划"}</Button></div></form></Dialog>
  </div>;
}
