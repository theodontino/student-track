import { getLLMCompletionOptions, type createLLMClient } from "@/lib/llm";
import {
  type FeedbackLength,
  type FeedbackStyle,
} from "@/lib/feedback-sections";
import { sanitizeFeedbackPromptText } from "@/lib/feedback-text-safety";
import { replaceFeedbackDatesWithRelativeLabels, relativeFeedbackDateLabel } from "@/lib/feedback-time";
import {
  FEEDBACK_CLOSURES_BY_TYPE,
  FEEDBACK_MODULES,
  FeedbackCompositionPlanSchema,
  FeedbackEvidenceBundleSchema,
  sanitizeFeedbackComposition,
  sanitizeFeedbackEvidenceBundle,
  type FeedbackCompositionPlan,
  type FeedbackEvidenceBundle,
  type FeedbackPlanType,
  type FeedbackGenerationPreferences,
} from "@/lib/feedback-plan";
import { ApiError } from "@/lib/api-errors";
import { createAuditSnapshot } from "@/services/feedback-plan-audit";

const FEEDBACK_DRAFT_INITIAL_MAX_TOKENS = 2048;
const FEEDBACK_DRAFT_RETRY_MAX_TOKENS = 4096;
const FEEDBACK_REPAIR_MAX_TOKENS = 4096;
const FEEDBACK_MAX_ATTEMPTS = 2;

type LLMClient = ReturnType<typeof createLLMClient>;

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("反馈生成已取消", "AbortError");
  }
}

function cleanJsonText(value: string) {
  let text = value.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function isJsonModeUnsupported(error: unknown) {
  const candidate = error as { status?: number; message?: string };
  return [400, 404, 422].includes(candidate?.status ?? 0)
    && /response[_ -]?format|json[_ -]?object|json mode/i.test(candidate?.message || "");
}

function isReasoningUnsupported(error: unknown) {
  const candidate = error as { status?: number; message?: string };
  return [400, 404, 422].includes(candidate?.status ?? 0)
    && /reasoning[_ -]?effort|thinking/i.test(candidate?.message || "");
}

function withoutReasoning<T extends Record<string, unknown>>(body: T) {
  const { reasoning_effort, ...rest } = body;
  void reasoning_effort;
  return rest;
}

async function createRepairCompletion(
  client: LLMClient,
  model: string,
  prompt: string,
  signal?: AbortSignal,
  options: { disableReasoning?: boolean; profileId?: string } = {},
) {
  throwIfAborted(signal);
  const configured = getLLMCompletionOptions("feedbackDraft", FEEDBACK_REPAIR_MAX_TOKENS, false, options.profileId);
  // “不传 reasoning_effort”并不等于关闭推理：部分 OpenAI 兼容模型
  // （例如 Qwen）会回到原生 thinking 默认值。重试时必须显式传 none。
  const reasoningEffort = options.disableReasoning ? "none" as const : configured.reasoning_effort;
  const baseBody = {
    model,
    messages: [{ role: "user" as const, content: prompt }],
    max_tokens: configured.max_tokens,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
  try {
    const body = {
      ...baseBody,
      response_format: { type: "json_object" as const },
    };
    return signal
      ? await client.chat.completions.create(body, { signal })
      : await client.chat.completions.create(body);
  } catch (error) {
    if (!isJsonModeUnsupported(error) && !isReasoningUnsupported(error)) throw error;
    // 降级：去掉 response_format 再试；reasoning_effort 保留以限制推理长度。
    const fallbackBody = isReasoningUnsupported(error) ? withoutReasoning(baseBody) : baseBody;
    return signal
      ? client.chat.completions.create(fallbackBody, { signal })
      : client.chat.completions.create(fallbackBody);
  }
}

async function generateCompositionDraft(
  client: LLMClient,
  model: string,
  prompt: string,
  signal?: AbortSignal,
  profileId?: string,
) {
  for (let attempt = 1; attempt <= FEEDBACK_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const requestedMaxTokens = attempt === 1
      ? FEEDBACK_DRAFT_INITIAL_MAX_TOKENS
      : FEEDBACK_DRAFT_RETRY_MAX_TOKENS;
    const configured = getLLMCompletionOptions("feedbackDraft", requestedMaxTokens, false, profileId);
    const reasoningEffort = attempt > 1
      ? "none" as const
      : configured.reasoning_effort ?? "none" as const;
    const baseBody = {
      model,
      messages: [{ role: "user" as const, content: prompt }],
      max_tokens: Math.max(configured.max_tokens, requestedMaxTokens),
      reasoning_effort: reasoningEffort,
    };
    const body = { ...baseBody, response_format: { type: "json_object" as const } };
    let response;
    try {
      response = signal
        ? await client.chat.completions.create(body, { signal })
        : await client.chat.completions.create(body);
    } catch (error) {
      if (!isReasoningUnsupported(error) && !isJsonModeUnsupported(error)) throw error;
      const fallbackBody = isJsonModeUnsupported(error)
        ? baseBody
        : withoutReasoning(body);
      response = signal
        ? await client.chat.completions.create(fallbackBody, { signal })
        : await client.chat.completions.create(fallbackBody);
    }
    if (isLengthTruncated(response)) continue;
    const content = response.choices[0]?.message?.content?.trim();
    if (content) return content;
  }
  throw new Error("LLM 返回空反馈内容，请重试");
}

function isLengthTruncated(response: { choices?: Array<{ finish_reason?: string | null }> }): boolean {
  return response.choices?.[0]?.finish_reason === "length";
}

export interface FreeFeedbackPlanGenerationInput {
  studentName: string;
  planType: FeedbackPlanType;
  outputRequirement: string;
  evidenceBundle: FeedbackEvidenceBundle;
  style: FeedbackStyle;
  length: FeedbackLength;
  draftClient: LLMClient;
  draftModel: string;
  generationPreferences?: FeedbackGenerationPreferences;
  referenceDate?: string;
  profileId?: string;
  existingTaskIds?: Set<string>;
  signal?: AbortSignal;
}

function parseComposition(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJsonText(value));
  } catch {
    throw new ApiError("反馈组装模型未返回合法 JSON，本条未保存；请重试", 502, "llm_schema_invalid", true);
  }
  // Parent action is optional and must fail conservatively. When a compatible
  // provider omits the nullable field or returns an incomplete action object,
  // downgrade the proposal to "no parent action". Deterministic audit and
  // teacher review still handle any action language left in the draft text;
  // we never fabricate a family task to make the schema pass.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const candidate = parsed as Record<string, unknown>;
    const parentAction = FeedbackCompositionPlanSchema.shape.parentAction.safeParse(candidate.parentAction);
    if (candidate.needParentAction !== true || !parentAction.success || parentAction.data === null) {
      parsed = { ...candidate, needParentAction: false, parentAction: null };
    }
  }
  const result = FeedbackCompositionPlanSchema.safeParse(parsed);
  if (result.success) return sanitizeFeedbackComposition(result.data);
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "root"))].slice(0, 4);
  throw new ApiError(`反馈组装模型缺少或写错字段：${fields.join("、")}；本条未保存`, 502, "llm_schema_invalid", true);
}

function normalizeCompositionDependencies(composition: FeedbackCompositionPlan) {
  if (composition.needParentAction && composition.parentAction) return composition;
  return {
    ...composition,
    needParentAction: false,
    parentAction: null,
    closureType: composition.closureType === "home_cooperation" ? "positive_recognition" as const : composition.closureType,
    modules: composition.modules.map((module) => module.key === "parent_action"
      ? { ...module, status: "blocked" as const, reason: "没有合法家长动作，程序已禁用此模块" }
      : module),
  };
}

export function modelEvidenceBundle(bundle: FeedbackEvidenceBundle, referenceDate?: string): FeedbackEvidenceBundle {
  if (!referenceDate) return bundle;
  const mapEvidence = (item: FeedbackEvidenceBundle["teachingEvidence"][number]) => ({
    ...item,
    content: replaceFeedbackDatesWithRelativeLabels(item.content, referenceDate),
    ...(item.occurredAt ? { occurredAt: relativeFeedbackDateLabel(referenceDate, item.occurredAt) } : {}),
  });
  const result: FeedbackEvidenceBundle = {
    ...bundle,
    teachingEvidence: bundle.teachingEvidence.map(mapEvidence),
    assessmentEvidence: bundle.assessmentEvidence.map(mapEvidence),
    communicationContext: bundle.communicationContext.map(mapEvidence),
    ...("teachingBackground" in bundle
      ? { teachingBackground: bundle.teachingBackground.map((value) => replaceFeedbackDatesWithRelativeLabels(value, referenceDate)) }
      : {}),
    ...("historySnapshot" in bundle
      ? {
          historySnapshot: bundle.historySnapshot
            ? {
                ...bundle.historySnapshot,
                current: bundle.historySnapshot.current ? { ...bundle.historySnapshot.current, date: relativeFeedbackDateLabel(referenceDate, bundle.historySnapshot.current.date) } : null,
                previous: bundle.historySnapshot.previous ? { ...bundle.historySnapshot.previous, date: relativeFeedbackDateLabel(referenceDate, bundle.historySnapshot.previous.date) } : null,
                recent: bundle.historySnapshot.recent.map((metric) => ({ ...metric, date: relativeFeedbackDateLabel(referenceDate, metric.date) })),
              }
            : null,
        }
      : {}),
  } as FeedbackEvidenceBundle;
  return result;
}

export function normalizeCompositionDates(composition: FeedbackCompositionPlan, referenceDate?: string) {
  if (!referenceDate) return composition;
  const text = (value: string) => replaceFeedbackDatesWithRelativeLabels(value, referenceDate);
  return sanitizeFeedbackComposition({
    ...composition,
    parentAction: composition.parentAction ? {
      ...composition.parentAction,
      action: text(composition.parentAction.action),
      successCriteria: text(composition.parentAction.successCriteria),
      notNeeded: text(composition.parentAction.notNeeded),
    } : null,
    modules: composition.modules.map((module) => ({
      ...module,
      content: text(module.content),
      reason: text(module.reason),
    })),
    evidenceCoverage: composition.evidenceCoverage.map((coverage) => ({ ...coverage, statement: text(coverage.statement) })),
    draftFeedback: text(composition.draftFeedback),
  });
}

function parseModelComposition(value: string, referenceDate?: string) {
  return normalizeCompositionDates(normalizeCompositionDependencies(parseComposition(value)), referenceDate);
}

function normalizedCoverageText(value: string) {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function retainCoveragePresentInFinalText(composition: FeedbackCompositionPlan) {
  const normalizedText = normalizedCoverageText(composition.draftFeedback);
  return {
    ...composition,
    evidenceCoverage: composition.evidenceCoverage.filter((coverage) => (
      normalizedText.includes(normalizedCoverageText(coverage.statement))
    )),
  };
}

/**
 * Current free-feedback executor. It performs one neutral composition stage;
 * deterministic audit and teacher review remain separate downstream gates.
 * Historical standard/fast values are intentionally not accepted here.
 */
export async function generateFreeFeedbackPlanComposition(input: FreeFeedbackPlanGenerationInput) {
  // Older persisted plans may still contain internal boundary metadata. Clean
  // it at the generation boundary without rewriting historical database rows.
  const evidence = sanitizeFeedbackEvidenceBundle(FeedbackEvidenceBundleSchema.parse(input.evidenceBundle));
  const modelEvidence = modelEvidenceBundle(evidence, input.referenceDate);
  const evidenceText = JSON.stringify(modelEvidence);
  const configuredModules = input.generationPreferences?.moduleKeys;
  const allowedModules = configuredModules?.length ? configuredModules : [...FEEDBACK_MODULES[input.planType]];
  const allowedClosures = input.generationPreferences
    ? [input.generationPreferences.closureType]
    : [...FEEDBACK_CLOSURES_BY_TYPE[input.planType]];
  const outputRequirement = sanitizeFeedbackPromptText(input.outputRequirement).trim();
  const evidenceIds = evidence.teachingEvidence.concat(evidence.assessmentEvidence, evidence.communicationContext)
    .filter((item) => item.confirmed && item.kind !== "model_candidate")
    .map((item) => item.id);
  const generationPreferenceBoundary = input.generationPreferences
    ? input.generationPreferences.moduleKeys.length
      ? `本计划在创建阶段已确定生成结构：只能使用结尾 ${input.generationPreferences.closureType}，只能在以下模块中选择：${input.generationPreferences.moduleKeys.join(", ")}。不得在本阶段改选其他结尾或模块。详略为 ${input.generationPreferences.length ?? "inherit"}，语气为 ${input.generationPreferences.tone ?? "inherit"}。`
      : `本计划在创建阶段没有预选模块；可以在当前反馈类型的完整模块目录中自然取舍，不要为了凑数量填充模块。结尾仍固定为 ${input.generationPreferences.closureType}。详略为 ${input.generationPreferences.length ?? "inherit"}，语气为 ${input.generationPreferences.tone ?? "inherit"}。`
    : "本计划没有保存生成结构偏好，按反馈类型的完整允许目录选择。";
  const baseProtocolBoundary = `当前类型允许的 module key 只有：${allowedModules.join(", ")}。
当前类型允许的 closureType 只有：${allowedClosures.join(", ")}。
evidenceRefs 只能逐字使用以下证据 ID：${evidenceIds.join(", ")}。

${generationPreferenceBoundary}

【时间语义协议】本次计划的目标课次作为“今天”的时间锚点。证据中的时间已经按实际发生时间分层为今天、昨天、前天或更早；不得把历史证据归入今天，不得在成稿中补写或重复精确日期。跨日沟通保留时间范围，不压成单日。

教师自然语言反馈要求与补充事实（最高优先级）：
${outputRequirement}

要求优先级：
1. 教师输入中的事实陈述视为教师已确认事实，可以补充或纠正证据包；与证据包冲突时，以教师本次输入为准；
2. 证据包中未被教师纠正的已确认事实继续作为内容底座；
3. 教师输入中的写作要求决定收件人、重点、语气、篇幅、表达顺序、取舍方式以及联想和分析尺度；
4. 内部结构化默认值只在教师自然语言没有说明时生效。
教师未指定收件人时，默认写给家长；教师明确指定其他收件人时按教师要求执行。
可以从教师输入与证据包共同形成的事实底座充分联想，形成原文没有直接写出的教学判断、可能原因和趋势解释；不要凭空编造两边都没有的具体事件、人物、分数或已经发生的动作。不要因为某句话属于分析、联想或推测就自动删除。`;
  const draftProtocolBoundary = `${baseProtocolBoundary}
已确认教学与测评证据应尽量自然地进入 draftFeedback；evidenceCoverage 用于帮助教师检查取舍，statement 应逐字出现在 draftFeedback 中。证据较多时可以合并判断、减少原始数据暴露，也可以把暂未写入正文的证据留给教师后续决定，不把覆盖检查当作阻断条件。`;
  const draftPrompt = `你是 Student Track 的反馈组装模型。请结合教师反馈要求、教师补充事实和证据包，为${input.studentName}生成结构化反馈组装方案。教师输入中的事实直接视为已确认事实；在这个事实底座上充分分析、联想、补充判断和自由表达。

反馈类型：${input.planType}
内部结构化默认值：表达风格 ${input.style}，篇幅 ${input.length}。仅在教师自然语言反馈要求未明确说明时采用。
确定性证据包：
${evidenceText}

结构协议（必须严格遵守）：
${draftProtocolBoundary}

规则：
1. modules 可以为空；如果纳入模块，只能从上面明确列出的 module key 中选择，不得自造、翻译或使用旧版模块名；若本计划已保存模块范围，只能从已选模块中选择。不要为了凑数量填充模块。内容来自证据包时填写对应 evidenceRefs；内容来自教师补充事实时 evidenceRefs 可以为空，不要伪造证据 ID。
2. teachingEvidence 与 assessmentEvidence 中的 confirmed=true 证据优先进入 included 模块和 draftFeedback；多条证据可以共同支撑同一个自然判断，不必逐项报数。evidenceCoverage 是教师复核辅助信息，能覆盖时填写，暂未覆盖不阻断草稿。
3. needParentAction 默认 false；教师要求需要家长配合时，再按自然表达填写 parentAction。
4. teacher_intervention、teacher_support、intervention_outcome 和 followup_observation 按内部结构字段正常输出；教师要求已经明确相关内容时，不要因为证据字段不完整而删掉正文。
5. closureType 只能从上面列出的当前类型选项中选择；若本计划已保存生成结构，必须使用已确定的结尾，不得因为示例中出现其他结尾就改选。
6. modules 和 evidenceCoverage 是审计元数据，不是正文模板。draftFeedback 应以教师判断为主体：从题目和课堂表现判断哪些内容已经能够使用、哪里还没有真正消化，以及问题更接近知识理解、条件识别、步骤习惯还是迁移能力。
7. 数据只用作家长能理解的判断锚点。优先保留总正确率和有解释价值的变化；题号、分项分数和重复数字尽量转化为知识点、方法或能力判断。
8. 主动分析教师输入和证据材料放在一起可能说明什么、当前更值得关注什么、哪些积极或风险信号正在出现。可以充分提出原文没有直接写出的解释、趋势和教学判断；不要凭空补出教师输入与证据包都没有的具体事件、人物、分数和已经发生的动作。
9. 这是供后续审核和老师删改的充分初稿，不使用最终长度要求。优先多保留有价值的判断、证据联系和表达角度；从最自然的地方起笔，不套固定顺序，证据较多时分句表达，并保留完整主语、连接词、适度重复和自然停顿。不要写标题或项目符号。

只返回 JSON：{
  "version":1,
  "closureType":"informational|positive_recognition|teacher_resolved|home_cooperation|continued_observation",
  "needParentAction":false,
  "parentAction":null,
  "modules":[{"key":"...","content":"...","evidenceRefs":[],"status":"included|omitted|blocked","reason":"..."}],
  "evidenceCoverage":[{"evidenceId":"...","statement":"draftFeedback 中逐字存在的对应事实短句"}],
  "draftFeedback":"..."
}`;
  const draftRaw = await generateCompositionDraft(input.draftClient, input.draftModel, draftPrompt, input.signal, input.profileId);
  let draftComposition;
  try {
    draftComposition = parseModelComposition(draftRaw, input.referenceDate);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "llm_schema_invalid") throw error;
    const repairPrompt = `你是 Student Track 的结构修复模型。下面的反馈组装输出不是合法结构，请只做 JSON 结构修复，完整保留教师要求授权的内容与表达力度。

反馈类型：${input.planType}
${draftProtocolBoundary}

无效输出：
${draftRaw.slice(0, 12000)}

请返回完整 JSON，必须包含 version=1、closureType、needParentAction、parentAction、modules、evidenceCoverage、draftFeedback。parentAction 不需要时必须为 null；每个 module 必须包含 key、content、evidenceRefs、status、reason；evidenceCoverage 只保留能够在 draftFeedback 中逐字找到的条目。`;
    const repairedResponse = await createRepairCompletion(input.draftClient, input.draftModel, repairPrompt, input.signal, {
      disableReasoning: true,
      profileId: input.profileId,
    });
    const repairedContent = repairedResponse.choices[0]?.message?.content?.trim();
    if (!repairedContent) throw error;
    draftComposition = parseModelComposition(repairedContent, input.referenceDate);
  }
  const composition = retainCoveragePresentInFinalText(draftComposition);
  return {
    draftComposition,
    composition,
    audit: createAuditSnapshot(
      composition,
      evidence,
      input.existingTaskIds,
      undefined,
      { enforceParentAudience: false, generationPreferences: input.generationPreferences },
    ),
    reviewRaw: null,
  };
}
