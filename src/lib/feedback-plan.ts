import { z } from "zod";
import { LessonFeedbackMaterialSchema, StudentAssessmentEvidenceSchema } from "@/lib/contracts/feedback";
import { FeedbackGenerationApproachSchema } from "@/lib/feedback-generation-approach";
import { containsStudentDirectedAddress, stripFeedbackInternalBoundary } from "@/lib/feedback-text-safety";

export {
  FEEDBACK_GENERATION_APPROACHES,
  FeedbackGenerationApproachSchema,
  type FeedbackGenerationApproach,
} from "@/lib/feedback-generation-approach";

export const FEEDBACK_PLAN_TYPES = ["class_update", "event_micro", "stage_trend", "course_end"] as const;
export type FeedbackPlanType = typeof FEEDBACK_PLAN_TYPES[number];

export const STUDENT_FEEDBACK_PLAN_TYPES = ["event_micro", "stage_trend", "course_end"] as const;
export type StudentFeedbackPlanType = typeof STUDENT_FEEDBACK_PLAN_TYPES[number];

/** Historical storage value. Current generation no longer exposes this as a choice. */
export const FEEDBACK_GENERATION_MODES = ["standard", "fast"] as const;
export type FeedbackGenerationMode = typeof FEEDBACK_GENERATION_MODES[number];

export const FEEDBACK_CLOSURE_TYPES = [
  "informational",
  "positive_recognition",
  "teacher_resolved",
  "home_cooperation",
  "continued_observation",
] as const;
export type FeedbackClosureType = typeof FEEDBACK_CLOSURE_TYPES[number];

export const FEEDBACK_CLOSURES_BY_TYPE = {
  class_update: ["informational"],
  event_micro: ["positive_recognition", "teacher_resolved", "home_cooperation", "continued_observation"],
  stage_trend: ["positive_recognition", "home_cooperation", "continued_observation"],
  course_end: ["positive_recognition", "home_cooperation"],
} as const satisfies Record<FeedbackPlanType, readonly FeedbackClosureType[]>;

export const PARENT_ACTION_TYPES = ["remind", "confirm", "provide_conditions", "report_anomaly"] as const;
export type ParentActionType = typeof PARENT_ACTION_TYPES[number];

export const FEEDBACK_MODULES = {
  class_update: ["lesson_scope", "key_difficulty", "class_handling", "homework_review", "next_lesson_link"],
  event_micro: ["observed_moment", "teacher_interpretation", "teacher_intervention", "intervention_outcome", "parent_action", "followup_observation"],
  stage_trend: ["starting_point", "recent_trend", "stable_capability", "unresolved_issue", "teacher_support", "next_stage_focus", "parent_action", "followup_observation"],
  course_end: ["starting_state", "evidence_backed_change", "stable_capability", "remaining_gap", "next_stage_learning_path", "parent_action"],
} as const;

export type FeedbackModuleKey = (typeof FEEDBACK_MODULES)[FeedbackPlanType][number];

export const FeedbackGenerationPreferencesSchema = z.object({
  closureType: z.enum(FEEDBACK_CLOSURE_TYPES),
  length: z.enum(["inherit", "short", "standard", "detailed"]).optional(),
  tone: z.enum(["inherit", "gentle", "professional"]).optional(),
  // An empty selection means that the current feedback type's full module
  // catalog is available. The upper bound is only a payload safety bound;
  // it is intentionally above every current type's catalog size.
  moduleKeys: z.array(z.string().trim().min(1).max(100)).max(12),
}).superRefine((value, ctx) => {
  if (new Set(value.moduleKeys).size !== value.moduleKeys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["moduleKeys"], message: "生成模块不能重复" });
  }
});
export type FeedbackGenerationPreferences = z.infer<typeof FeedbackGenerationPreferencesSchema>;

export const FeedbackPlanItemGenerationConfigSchema = z.object({
  version: z.literal(1),
  type: z.enum(FEEDBACK_PLAN_TYPES),
  outputRequirement: z.string().trim().min(1).max(2000),
  generationPreferences: FeedbackGenerationPreferencesSchema,
});
export type FeedbackPlanItemGenerationConfig = z.infer<typeof FeedbackPlanItemGenerationConfigSchema>;

export const FeedbackPlanStudentOverrideSchema = z.object({
  studentId: z.string().trim().min(1).max(200),
  generationConfig: FeedbackPlanItemGenerationConfigSchema,
});
export type FeedbackPlanStudentOverride = z.infer<typeof FeedbackPlanStudentOverrideSchema>;

const DEFAULT_FEEDBACK_GENERATION_PREFERENCES: Record<FeedbackPlanType, FeedbackGenerationPreferences> = {
  class_update: {
    closureType: "informational",
    moduleKeys: ["lesson_scope", "key_difficulty", "class_handling"],
  },
  event_micro: {
    closureType: "positive_recognition",
    moduleKeys: ["observed_moment", "teacher_interpretation"],
  },
  stage_trend: {
    closureType: "positive_recognition",
    moduleKeys: ["recent_trend", "stable_capability", "unresolved_issue"],
  },
  course_end: {
    closureType: "positive_recognition",
    moduleKeys: ["starting_state", "evidence_backed_change", "remaining_gap"],
  },
};

export function defaultFeedbackGenerationPreferences(planType: FeedbackPlanType): FeedbackGenerationPreferences {
  const defaults = DEFAULT_FEEDBACK_GENERATION_PREFERENCES[planType];
  // Keep the old payload shape for callers that do not opt into the new
  // public length/tone controls. Missing values are treated as "inherit" at
  // generation time, so old plans remain fully compatible.
  return { closureType: defaults.closureType, moduleKeys: [...defaults.moduleKeys] };
}

export function normalizeFeedbackGenerationPreferences(
  planType: FeedbackPlanType,
  value?: unknown,
): FeedbackGenerationPreferences {
  const parsed = FeedbackGenerationPreferencesSchema.parse(value ?? defaultFeedbackGenerationPreferences(planType));
  const allowedClosures = FEEDBACK_CLOSURES_BY_TYPE[planType] as readonly string[];
  const allowedModules = FEEDBACK_MODULES[planType] as readonly string[];
  if (!allowedClosures.includes(parsed.closureType)) {
    throw new Error(`反馈类型 ${planType} 不允许结尾 ${parsed.closureType}`);
  }
  const unsupportedModule = parsed.moduleKeys.find((key) => !allowedModules.includes(key));
  if (unsupportedModule) throw new Error(`反馈类型 ${planType} 不允许模块 ${unsupportedModule}`);
  const hasExplicitModuleSelection = parsed.moduleKeys.length > 0;
  if (hasExplicitModuleSelection && parsed.closureType === "continued_observation" && !parsed.moduleKeys.includes("followup_observation")) {
    throw new Error("继续观察结尾必须选择后续观察模块");
  }
  if (hasExplicitModuleSelection && parsed.closureType === "teacher_resolved" && !parsed.moduleKeys.includes("teacher_intervention")) {
    throw new Error("教师已处理结尾必须选择教师处理模块");
  }
  if (hasExplicitModuleSelection && parsed.closureType === "home_cooperation" && !parsed.moduleKeys.includes("parent_action")) {
    throw new Error("家庭配合结尾必须选择家长动作模块");
  }
  return parsed;
}

const sourceRefSchema = z.object({
  type: z.string().min(1).max(80),
  id: z.string().min(1).max(200),
  label: z.string().max(500).optional(),
});

const evidenceItemSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["fact", "teacher_judgment", "model_candidate"]),
  content: z.string().min(1).max(3000),
  sourceRefs: z.array(sourceRefSchema).max(20),
  occurredAt: z.string().max(64).optional(),
  confirmed: z.boolean().default(false),
});

const feedbackHistoryMetricSchema = z.object({
  metricId: z.string().max(200).optional(),
  sessionId: z.string().max(200).nullable().optional(),
  date: z.string().max(64),
  semesterNumber: z.number().int().min(0).max(10000),
  scoreA: z.number().min(0).max(5).nullable(),
  scoreB: z.number().int().min(0).max(5).nullable(),
  scoreC: z.number().int().min(0).max(5).nullable(),
  scoreD: z.number().int().min(0).max(5).nullable(),
});

export const FeedbackHistorySnapshotSchema = z.object({
  version: z.literal(1),
  current: feedbackHistoryMetricSchema.extend({ present: z.boolean().nullable() }).nullable(),
  previous: feedbackHistoryMetricSchema.nullable(),
  recent: z.array(feedbackHistoryMetricSchema).max(6),
  semesterAverage: z.object({
    A: z.number().min(0).max(5).nullable(),
    B: z.number().min(0).max(5).nullable(),
    C: z.number().min(0).max(5).nullable(),
    D: z.number().min(0).max(5).nullable(),
  }),
});
export type FeedbackHistorySnapshot = z.infer<typeof FeedbackHistorySnapshotSchema>;

const feedbackEvidenceBundleFields = {
  planType: z.enum(FEEDBACK_PLAN_TYPES),
  studentId: z.string().max(200).nullable(),
  teachingEvidence: z.array(evidenceItemSchema).max(100),
  assessmentEvidence: z.array(evidenceItemSchema).max(50).default([]),
  communicationContext: z.array(evidenceItemSchema).max(50),
  executionConstraints: z.object({
    existingTaskIds: z.array(z.string().max(200)).max(50),
    fixedArrangementRefs: z.array(sourceRefSchema).max(50),
    teacherInterventionPresent: z.boolean(),
  }),
  sourceRefs: z.array(sourceRefSchema).max(100),
  sourceFingerprint: z.string().min(16).max(128),
};

export const FeedbackEvidenceBundleV1Schema = z.object({
  version: z.literal(1),
  ...feedbackEvidenceBundleFields,
});

export const FeedbackEvidenceBundleV2Schema = z.object({
  version: z.literal(2),
  ...feedbackEvidenceBundleFields,
  // 课程公共材料只作为教学背景，不能被当成学生个人表现证据。
  teachingBackground: z.array(z.string().max(3000)).max(100).default([]),
  historySnapshot: FeedbackHistorySnapshotSchema.nullable(),
});

export const FeedbackEvidenceBundleSchema = z.union([
  FeedbackEvidenceBundleV1Schema,
  FeedbackEvidenceBundleV2Schema,
]);
export type FeedbackEvidenceBundle = z.infer<typeof FeedbackEvidenceBundleSchema>;

const feedbackPlanInputSnapshotFields = {
  version: z.literal(1),
  semesterId: z.string().max(200).optional(),
  classId: z.string().max(200).optional(),
  sessionId: z.string().max(200).optional(),
  rangeStartSessionId: z.string().max(200).optional(),
  rangeEndSessionId: z.string().max(200).optional(),
  sessionCode: z.string().max(128).optional(),
  sourceFingerprint: z.string().max(128).optional(),
  lessonMaterial: LessonFeedbackMaterialSchema,
  generationPreferences: FeedbackGenerationPreferencesSchema.optional(),
};

export const FeedbackPlanInputSnapshotV1Schema = z.object(feedbackPlanInputSnapshotFields);

export const FeedbackPlanIntakeSourceSummarySchema = z.object({
  intakeRunId: z.string().min(1).max(200),
  sessionCode: z.string().max(128),
  status: z.string().max(40),
  confirmedAt: z.string().max(64).nullable(),
  sourceCount: z.number().int().nonnegative(),
  recognizedCount: z.number().int().nonnegative(),
  ignoredCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  resolvedDecisionCount: z.number().int().nonnegative().optional(),
  resolutions: z.array(z.object({
    action: z.string().min(1).max(80),
    sourceName: z.string().max(500).optional(),
    detail: z.string().max(500).optional(),
  })).max(200).optional(),
  sources: z.array(z.object({
    name: z.string().max(500),
    kind: z.string().max(80),
    source: z.string().max(40),
  })).max(200),
});
export type FeedbackPlanIntakeSourceSummary = z.infer<typeof FeedbackPlanIntakeSourceSummarySchema>;

export const CommunicationPreferenceSchema = z.object({
  version: z.literal(1),
  length: z.enum(["unknown", "short", "standard", "detailed", "flexible"]),
  deliveryChannel: z.enum(["unknown", "text", "voice", "either"]).default("unknown"),
  phoneContact: z.enum(["unknown", "accepted", "not_accepted"]).default("unknown"),
  evidence: z.enum(["unknown", "teacher_conclusion", "classroom_example", "data_trend"]),
  terminology: z.enum(["unknown", "plain", "basic", "professional"]),
  familyParticipation: z.enum(["unknown", "inform_only", "remind_confirm", "observe_report", "simple_check"]),
  frequency: z.enum(["unknown", "every_session", "stage_only", "exception_only"]),
});
export type CommunicationPreference = z.infer<typeof CommunicationPreferenceSchema>;

export const FeedbackPlanFrozenFactItemSchema = z.object({
  studentId: z.string().max(200).nullable(),
  studentName: z.string().max(200).optional(),
  studentNumber: z.string().max(200).optional(),
  communicationPreference: CommunicationPreferenceSchema.nullable().optional(),
  referenceDate: z.string().max(64).optional(),
  evidence: FeedbackEvidenceBundleSchema,
});

export const FeedbackPlanInputSnapshotV2Schema = z.object({
  ...feedbackPlanInputSnapshotFields,
  version: z.literal(2),
  draftRequestKey: z.string().min(8).max(200).optional(),
  batchGenerationPreferences: FeedbackGenerationPreferencesSchema.optional(),
  selectedStudentIds: z.array(z.string().max(200)).max(200),
  studentOverrides: z.array(FeedbackPlanStudentOverrideSchema).max(200),
  factSnapshot: z.object({
    capturedAt: z.string().max(64),
    items: z.array(FeedbackPlanFrozenFactItemSchema).max(201),
  }),
  intakeSources: z.array(FeedbackPlanIntakeSourceSummarySchema).max(20),
});

export const FeedbackPlanInputSnapshotSchema = z.union([
  FeedbackPlanInputSnapshotV2Schema,
  FeedbackPlanInputSnapshotV1Schema,
]);
export type FeedbackPlanInputSnapshot = z.infer<typeof FeedbackPlanInputSnapshotSchema>;

export function sanitizeFeedbackEvidenceBundle(bundle: FeedbackEvidenceBundle): FeedbackEvidenceBundle {
  const clean = (items: FeedbackEvidenceBundle["teachingEvidence"]) => items
    .map((item) => ({
      ...item,
      content: stripFeedbackInternalBoundary(item.content),
    }))
    .filter((item) => item.content.length > 0);
  return {
    ...bundle,
    teachingEvidence: clean(bundle.teachingEvidence),
    assessmentEvidence: clean(bundle.assessmentEvidence),
    communicationContext: clean(bundle.communicationContext),
  };
}

const moduleStatusSchema = z.enum(["included", "omitted", "blocked"]);

export const FeedbackModuleSchema = z.object({
  key: z.string().min(1).max(100),
  content: z.string().max(5000),
  evidenceRefs: z.array(z.string().max(200)).max(200),
  status: moduleStatusSchema,
  reason: z.string().max(500),
});
export type FeedbackModule = z.infer<typeof FeedbackModuleSchema>;

export const FeedbackCompositionPlanSchema = z.object({
  version: z.literal(1),
  closureType: z.enum(FEEDBACK_CLOSURE_TYPES),
  needParentAction: z.boolean(),
  parentAction: z.object({
    type: z.enum(PARENT_ACTION_TYPES),
    actor: z.literal("parent"),
    action: z.string().min(1).max(1000),
    successCriteria: z.string().max(500),
    notNeeded: z.string().max(500),
  }).nullable(),
  modules: z.array(FeedbackModuleSchema).max(12),
  evidenceCoverage: z.array(z.object({
    evidenceId: z.string().min(1).max(200),
    statement: z.string().trim().min(2).max(1000),
  })).max(150).default([]),
  draftFeedback: z.string().max(10000),
});
export type FeedbackCompositionPlan = z.infer<typeof FeedbackCompositionPlanSchema>;

export function sanitizeFeedbackComposition(composition: FeedbackCompositionPlan): FeedbackCompositionPlan {
  return {
    ...composition,
    parentAction: composition.parentAction ? {
      ...composition.parentAction,
      action: stripFeedbackInternalBoundary(composition.parentAction.action),
      successCriteria: stripFeedbackInternalBoundary(composition.parentAction.successCriteria),
      notNeeded: stripFeedbackInternalBoundary(composition.parentAction.notNeeded),
    } : null,
    modules: composition.modules.map((module) => ({
      ...module,
      content: stripFeedbackInternalBoundary(module.content),
      reason: stripFeedbackInternalBoundary(module.reason),
    })),
    evidenceCoverage: composition.evidenceCoverage
      .map((coverage) => ({ ...coverage, statement: stripFeedbackInternalBoundary(coverage.statement) }))
      .filter((coverage) => coverage.statement.length >= 2),
    draftFeedback: stripFeedbackInternalBoundary(composition.draftFeedback),
  };
}

export const FeedbackAuditItemSchema = z.object({
  code: z.string().min(1).max(100),
  severity: z.enum(["info", "requires_teacher", "blocked"]),
  message: z.string().min(1).max(1000),
  excerpt: z.string().max(500).optional(),
  taskId: z.string().max(200).optional(),
});

export const HARD_FEEDBACK_AUDIT_CODES = new Set([
  "empty_text",
  "cross_student_content",
  "unconfirmed_evidence",
]);

export function isHardFeedbackAuditIssue(code: string) {
  return HARD_FEEDBACK_AUDIT_CODES.has(code);
}

export const FeedbackAuditSnapshotSchema = z.object({
  version: z.literal(1),
  status: z.enum(["pass", "needs_review", "blocked"]),
  items: z.array(FeedbackAuditItemSchema).max(100),
  textHash: z.string().max(128),
  semanticReviewRequired: z.boolean(),
});
export type FeedbackAuditSnapshot = z.infer<typeof FeedbackAuditSnapshotSchema>;

const feedbackPlanAssessmentEvidenceValueSchema = z.union([
  StudentAssessmentEvidenceSchema,
  z.array(StudentAssessmentEvidenceSchema).min(1).max(20),
]);

export const FeedbackPlanAssessmentEvidenceSchema = z.record(
  z.string().trim().min(1).max(200),
  feedbackPlanAssessmentEvidenceValueSchema,
).refine((value) => Object.keys(value).length <= 200, {
  message: "assessmentEvidence cannot contain more than 200 students",
});
export type FeedbackPlanAssessmentEvidenceInput = z.infer<typeof FeedbackPlanAssessmentEvidenceSchema>;

export const FeedbackPlanCreateSchema = z.object({
  requestKey: z.string().trim().min(8).max(200).optional(),
  displayName: z.string().trim().min(1).max(120).nullable().optional(),
  basedOnPlanId: z.string().trim().min(1).max(200).optional(),
  type: z.enum(FEEDBACK_PLAN_TYPES),
  outputRequirement: z.string().trim().min(1).max(2000),
  generationApproach: FeedbackGenerationApproachSchema.default("restricted"),
  semesterId: z.string().trim().min(1).max(200),
  classId: z.string().trim().min(1).max(200),
  sessionId: z.string().trim().max(200).optional(),
  rangeStartSessionId: z.string().trim().max(200).optional(),
  rangeEndSessionId: z.string().trim().max(200).optional(),
  studentIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  intakeRunIds: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  assessmentEvidence: FeedbackPlanAssessmentEvidenceSchema.optional(),
  lessonMaterial: LessonFeedbackMaterialSchema.optional(),
  generationPreferences: FeedbackGenerationPreferencesSchema.optional(),
  studentOverrides: z.array(FeedbackPlanStudentOverrideSchema).max(200).superRefine((overrides, ctx) => {
    const ids = new Set<string>();
    overrides.forEach((override, index) => {
      if (ids.has(override.studentId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "studentId"], message: "同一学生不能重复设置独立计划" });
      }
      ids.add(override.studentId);
    });
  }).optional(),
});
export type FeedbackPlanCreateInput = z.input<typeof FeedbackPlanCreateSchema>;

export const FeedbackPlanDraftPatchSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  type: z.enum(FEEDBACK_PLAN_TYPES).optional(),
  outputRequirement: z.string().trim().min(1).max(2000).optional(),
  generationApproach: FeedbackGenerationApproachSchema.optional(),
  studentIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  generationPreferences: FeedbackGenerationPreferencesSchema.optional(),
  studentOverrides: z.array(FeedbackPlanStudentOverrideSchema).max(200).superRefine((overrides, ctx) => {
    const ids = new Set<string>();
    overrides.forEach((override, index) => {
      if (ids.has(override.studentId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "studentId"], message: "同一学生不能重复设置独立计划" });
      }
      ids.add(override.studentId);
    });
  }).optional(),
  expectedPlanRevision: z.number().int().positive(),
}).refine((patch) => Object.keys(patch).some((key) => key !== "expectedPlanRevision"), {
  message: "反馈计划草稿没有可保存的修改",
});
export type FeedbackPlanDraftPatch = z.infer<typeof FeedbackPlanDraftPatchSchema>;

export const FeedbackPlanRenameSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  expectedPlanRevision: z.number().int().positive().optional(),
});
export type FeedbackPlanRenameInput = z.infer<typeof FeedbackPlanRenameSchema>;

export const FeedbackPlanCloneDraftSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  generationApproach: FeedbackGenerationApproachSchema.optional(),
});
export type FeedbackPlanCloneDraftInput = z.infer<typeof FeedbackPlanCloneDraftSchema>;

export const FeedbackPlanItemPatchSchema = z.object({
  composition: FeedbackCompositionPlanSchema.optional(),
  finalText: z.string().max(10000).optional(),
  reviewMode: z.enum(["model", "teacher_edited"]).optional(),
  expectedItemRevision: z.number().int().positive().optional(),
  generationConfig: FeedbackPlanItemGenerationConfigSchema.nullable().optional(),
});
export type FeedbackPlanItemPatch = z.infer<typeof FeedbackPlanItemPatchSchema>;

export function stableJson(value: unknown) {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

// 只拦截明确面向教师内部的语境；“分子模型”“原子模型”等学科词汇属于正常教学事实。
const INTERNAL_CONTENT = /(?:续班(?:建议|判断|结论)?|退班(?:建议|判断|意向)?|销售(?:话术|文案|结论)?|(?:AI|LLM|语言模型)(?:生成|审核|润色|反馈)?|内部研判|风险标签|教师任务)/iu;
const PROMISE_PATTERNS = [
  /我会(?:继续|单独|额外|及时|持续|下次)/u,
  /(?:老师|我)(?:会|将会|将在).{0,24}(?:检查|观察|复测|沟通|安排|反馈|跟进|关注)/u,
  /下次(?:课|测验).{0,20}(?:检查|观察|复测|沟通|安排)/u,
  /后续(?:继续|重点|跟进|关注)/u,
  /持续关注/u,
  /随时联系/u,
  /每天(?:跟进|监督)/u,
  /保证(?:掌握|提高|完成)/u,
];
// 课堂里“提醒学生”“确认掌握”不是家长动作。只有明确指向家长/您，或出现
// “家长可以/只需要”等主体时，才把文本视为家长动作。
const PARENT_ACTION_PATTERNS = /(?:请(?:您|家长)|麻烦(?:您|家长)|(?:希望|建议)家长|家长(?:可以|只需要|只需|需要|需|这边))/u;

function coverageText(value: string) {
  return value.normalize("NFKC")
    // 时间标签是表达层信息；比较证据时不应因为程序把精确日期换成
    // “昨天/今天”就误判为无依据。
    .replace(/(?<!\d)\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:日)?(?!\d)/gu, "")
    .replace(/今天|昨天|前天|更早|之后|时间未知/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLocaleLowerCase("zh-CN");
}

function evidenceStatementMatches(evidenceContent: string, statement: string) {
  const normalizedEvidence = coverageText(evidenceContent);
  const normalizedStatement = coverageText(statement);
  const hanRuns = evidenceContent.match(/[\p{Script=Han}]+/gu) ?? [];
  const bigrams = new Set(hanRuns.flatMap((run) => (
    [...run].slice(0, -1).map((character, index) => `${character}${[...run][index + 1]}`)
  )));
  const overlappingBigrams = [...bigrams].filter((token) => normalizedStatement.includes(token));
  return normalizedEvidence.includes(normalizedStatement)
    || normalizedStatement.includes(normalizedEvidence)
    || overlappingBigrams.length >= Math.min(2, bigrams.size);
}

export function validateCompositionForBundle(
  composition: FeedbackCompositionPlan,
  bundle: FeedbackEvidenceBundle,
  taskIds: Set<string> = new Set(bundle.executionConstraints.existingTaskIds),
  identity?: { studentName?: string; otherStudentNames?: string[] },
  options: { enforceParentAudience?: boolean; generationPreferences?: FeedbackGenerationPreferences } = {},
): { status: FeedbackAuditSnapshot["status"]; issues: z.infer<typeof FeedbackAuditItemSchema>[] } {
  const issues: z.infer<typeof FeedbackAuditItemSchema>[] = [];
  const included = composition.modules.filter((module) => module.status === "included");
  const evidence = bundle.teachingEvidence.concat(bundle.assessmentEvidence, bundle.communicationContext);
  const evidenceIds = new Set(evidence.filter((item) => item.confirmed && item.kind !== "model_candidate").map((item) => item.id));
  const configuredModules = options.generationPreferences?.moduleKeys;
  const allowedModules = new Set(configuredModules?.length ? configuredModules : FEEDBACK_MODULES[bundle.planType]);
  const allowedClosures = new Set<FeedbackClosureType>(options.generationPreferences
    ? [options.generationPreferences.closureType]
    : FEEDBACK_CLOSURES_BY_TYPE[bundle.planType]);

  if (!composition.draftFeedback.trim()) {
    issues.push({ code: "empty_text", severity: "blocked", message: "最终反馈文本为空" });
  }
  if (options.enforceParentAudience && containsStudentDirectedAddress(composition.draftFeedback)) {
    issues.push({
      code: "recipient_mismatch",
      severity: "blocked",
      message: "家长反馈直接对学生使用了第二人称或学生式鼓励语",
    });
  }
  for (const section of included) {
    if (!allowedModules.has(section.key as never)) {
      issues.push({ code: "module_not_allowed", severity: "blocked", message: `当前反馈类型不允许模块：${section.key}` });
    }
    if (section.evidenceRefs.some((ref) => !evidenceIds.has(ref))) {
      issues.push({ code: "evidence_ref_missing", severity: "blocked", message: `模块 ${section.key} 引用了不存在的证据` });
    }
  }
  const requiredEvidenceIds = new Set(bundle.teachingEvidence.concat(bundle.assessmentEvidence)
    .filter((item) => item.confirmed && item.kind !== "model_candidate")
    .map((item) => item.id));
  const includedEvidenceIds = new Set(included.flatMap((module) => module.evidenceRefs));
  const omittedEvidenceIds = [...requiredEvidenceIds].filter((id) => !includedEvidenceIds.has(id));
  const softOmittedEvidenceIds = new Set(omittedEvidenceIds);
  const coverageByEvidenceId = new Map<string, string>();
  const duplicateCoverageIds = new Set<string>();
  for (const coverage of composition.evidenceCoverage) {
    if (coverageByEvidenceId.has(coverage.evidenceId)) duplicateCoverageIds.add(coverage.evidenceId);
    coverageByEvidenceId.set(coverage.evidenceId, coverage.statement);
  }
  if (duplicateCoverageIds.size > 0) {
    issues.push({
      code: "evidence_coverage_duplicate",
      severity: "blocked",
      message: `同一证据不能重复声明正文覆盖：${[...duplicateCoverageIds].join("、")}`,
    });
  }
  const unknownCoverageIds = [...coverageByEvidenceId.keys()].filter((id) => !requiredEvidenceIds.has(id));
  if (unknownCoverageIds.length > 0) {
    issues.push({
      code: "evidence_coverage_unknown",
      severity: "blocked",
      message: `正文覆盖声明引用了非教学/测评证据：${unknownCoverageIds.join("、")}`,
    });
  }
  const invalidTextCoverageIds: string[] = [];
  const normalizedDraft = coverageText(composition.draftFeedback);
  for (const evidenceItem of bundle.teachingEvidence.concat(bundle.assessmentEvidence)
    .filter((item) => item.confirmed && item.kind !== "model_candidate")) {
    const statement = coverageByEvidenceId.get(evidenceItem.id);
    if (!statement) {
      softOmittedEvidenceIds.add(evidenceItem.id);
      continue;
    }
    if (!normalizedDraft.includes(coverageText(statement))) {
      softOmittedEvidenceIds.add(evidenceItem.id);
      continue;
    }
    if (!evidenceStatementMatches(evidenceItem.content, statement)) invalidTextCoverageIds.push(evidenceItem.id);
  }
  if (invalidTextCoverageIds.length > 0) {
    issues.push({
      code: "evidence_coverage_unsubstantiated",
      severity: "requires_teacher",
      message: `以下正文覆盖句与对应证据缺少可追溯的关键词关联：${invalidTextCoverageIds.join("、")}`,
    });
  }
  if (softOmittedEvidenceIds.size > 0) {
    issues.push({
      code: "final_evidence_omitted",
      severity: "requires_teacher",
      message: `当前正文未呈现以下已确认证据，教师可选择补入或接受删减：${[...softOmittedEvidenceIds].join("、")}`,
    });
  }
  const unconfirmedRef = included.flatMap((module) => module.evidenceRefs).find((ref) => evidence.some((item) => item.id === ref && (!item.confirmed || item.kind === "model_candidate")));
  if (unconfirmedRef) {
    issues.push({ code: "unconfirmed_evidence", severity: "blocked", message: `引用的证据 ${unconfirmedRef} 尚未由教师确认` });
  }
  if (composition.needParentAction !== Boolean(composition.parentAction)) {
    issues.push({ code: "parent_action_mismatch", severity: "blocked", message: "家长动作开关与动作内容不一致" });
  }
  if (composition.parentAction && !composition.needParentAction) {
    issues.push({ code: "parent_action_disabled", severity: "blocked", message: "未启用家长动作时不能包含家庭任务" });
  }
  if (composition.parentAction && !included.some((module) => module.key === "parent_action")) {
    issues.push({ code: "parent_action_module_missing", severity: "blocked", message: "家长动作必须通过家长动作模块进入反馈" });
  }
  if (included.some((module) => module.key === "parent_action") && (!composition.needParentAction || !composition.parentAction)) {
    issues.push({ code: "parent_action_content_missing", severity: "blocked", message: "家长动作模块必须关联合法的家长动作内容" });
  }
  if (included.some((module) => module.key === "teacher_intervention" || module.key === "teacher_support")
    && !bundle.executionConstraints.teacherInterventionPresent) {
    issues.push({ code: "teacher_intervention_unconfirmed", severity: "blocked", message: "没有已确认的教师处理证据" });
  }
  if (included.some((module) => module.key === "intervention_outcome")
    && !included.some((module) => module.key === "teacher_intervention")) {
    issues.push({ code: "intervention_outcome_without_action", severity: "blocked", message: "处理结果必须依赖教师处理" });
  }
  if (included.some((module) => module.key === "followup_observation") && taskIds.size === 0) {
    issues.push({ code: "followup_without_task", severity: "blocked", message: "后续观察必须关联已存在或已批准的教师任务" });
  }
  if (composition.closureType === "continued_observation" && !included.some((module) => module.key === "followup_observation")) {
    issues.push({ code: "closure_requires_followup", severity: "blocked", message: "继续观察结尾必须包含后续观察模块" });
  }
  if (composition.closureType === "teacher_resolved" && !included.some((module) => module.key === "teacher_intervention")) {
    issues.push({ code: "closure_requires_intervention", severity: "blocked", message: "教师已处理结尾必须包含已确认的教师处理模块" });
  }
  if (composition.closureType === "home_cooperation" && !composition.needParentAction) {
    issues.push({ code: "closure_requires_parent_action", severity: "blocked", message: "家庭配合结尾必须启用家长动作" });
  }
  if (!allowedClosures.has(composition.closureType)) {
    issues.push({ code: "closure_not_allowed", severity: "blocked", message: `当前反馈类型不能使用 ${composition.closureType} 结尾` });
  }
  if (INTERNAL_CONTENT.test(composition.draftFeedback)) {
    issues.push({ code: "internal_content_leak", severity: "blocked", message: "反馈包含教师内部信息" });
  }
  if (identity?.otherStudentNames?.some((name) => name && name !== identity.studentName && composition.draftFeedback.includes(name))) {
    issues.push({ code: "cross_student_content", severity: "blocked", message: "反馈文本出现其他学生姓名" });
  }
  if (PARENT_ACTION_PATTERNS.test(composition.draftFeedback) && !composition.needParentAction) {
    issues.push({ code: "implicit_parent_action", severity: "blocked", message: "文本出现家庭动作但未启用家长动作模块" });
  }
  const promiseDetected = PROMISE_PATTERNS.find((pattern) => pattern.test(composition.draftFeedback));
  if (promiseDetected && taskIds.size === 0) {
    issues.push({ code: "promise_without_task", severity: "blocked", message: "反馈包含教师未来动作但没有关联任务" });
  } else if (promiseDetected) {
    issues.push({ code: "promise_requires_teacher", severity: "requires_teacher", message: "反馈包含教师未来动作，请确认任务范围与截止节点" });
  }

  const normalizedIssues = issues.map((issue) => (
    issue.severity === "blocked" && !isHardFeedbackAuditIssue(issue.code)
      ? { ...issue, severity: "requires_teacher" as const }
      : issue
  ));
  const status = normalizedIssues.some((issue) => issue.severity === "blocked")
    ? "blocked"
    : normalizedIssues.some((issue) => issue.severity === "requires_teacher") ? "needs_review" : "pass";
  return { status, issues: normalizedIssues };
}
