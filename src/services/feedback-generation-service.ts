import type { createLLMClient } from "@/lib/llm";
import {
  assessmentEvidencePrompt,
  lessonMaterialPrompt,
  type LessonFeedbackMaterial,
  type StudentAssessmentEvidence,
} from "@/lib/feedback-materials";

const FEEDBACK_MAX_TOKENS = 2048;
const FEEDBACK_MAX_ATTEMPTS = 2;

type LLMClient = ReturnType<typeof createLLMClient>;

export type FeedbackReviewStatus = "passed" | "revised" | "needs_review" | "edited";

export interface ReviewedFeedback {
  draftFeedback: string;
  feedback: string;
  reviewStatus: Exclude<FeedbackReviewStatus, "edited">;
  reviewIssues: string[];
}

interface FeedbackDraftInput {
  studentName: string;
  promptContext: string;
  lengthRequirement: string;
  client: LLMClient;
  model: string;
}

interface FeedbackReviewInput extends FeedbackDraftInput {
  draftFeedback: string;
  forbiddenStudentNames?: string[];
}

interface GenerateReviewedFeedbackInput {
  studentName: string;
  promptContext: string;
  forbiddenStudentNames?: string[];
  lengthRequirement: string;
  draftClient: LLMClient;
  draftModel: string;
  reviewClient: LLMClient;
  reviewModel: string;
}

interface ReviewPayload {
  verdict?: unknown;
  feedback?: unknown;
  issues?: unknown;
}

export function composeFeedbackPromptContext(input: {
  studentContext: string;
  sessionCode?: string;
  studentId?: string;
  lessonMaterial?: LessonFeedbackMaterial | null;
  assessmentEvidence?: StudentAssessmentEvidence | null;
}) {
  return [
    input.sessionCode
      ? `【本次生成边界】课次：${input.sessionCode}${input.studentId ? `；学生ID：${input.studentId}` : ""}。以下课堂信息、评价、助教记录、家长沟通和 PDF 证据统一作为本次背景；不得使用其他课次或其他学生的材料。`
      : "",
    input.studentContext.trim(),
    lessonMaterialPrompt(input.lessonMaterial),
    assessmentEvidencePrompt(input.assessmentEvidence),
    `【证据使用顺序】
1. 个人出门测报告、已确认的本课评价、考勤、事件和助教备注必须同时符合上述课次与学生身份，才属于该生证据。
2. 学期对照只描述最近两次相对个人常态和同期班均的位置，不得改写成排名。
3. 家校沟通用于选择家长关心的表达重点，不得改变教学事实。
4. 课程公共材料和统一出门测说明只能描述全班学习内容、考查范围与统一建议，不得据此断言该生掌握或失误。
5. 多项证据冲突或依据不足时必须保守表达，并交给人工确认。`,
  ].filter(Boolean).join("\n\n");
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

function parseReviewPayload(value: string): ReviewPayload {
  const parsed = JSON.parse(cleanJsonText(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("审核模型未返回 JSON 对象");
  }
  return parsed as ReviewPayload;
}

function normalizeIssues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => {
    if (typeof item === "string") return item.trim();
    if (item && typeof item === "object" && "message" in item && typeof item.message === "string") {
      return item.message.trim();
    }
    return "";
  }).filter(Boolean))].slice(0, 8);
}

function normalizeVerdict(value: unknown) {
  const verdict = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (["pass", "passed", "通过"].includes(verdict)) return "passed" as const;
  if (["revise", "revised", "修订", "已修订"].includes(verdict)) return "revised" as const;
  return "needs_review" as const;
}

function isJsonModeUnsupported(error: unknown) {
  const candidate = error as { status?: number; message?: string };
  return [400, 404, 422].includes(candidate?.status ?? 0)
    && /response[_ -]?format|json[_ -]?object|json mode/i.test(candidate?.message || "");
}

async function createReviewCompletion(client: LLMClient, model: string, prompt: string) {
  const request = {
    model,
    messages: [{ role: "user" as const, content: prompt }],
    temperature: 0,
    max_tokens: FEEDBACK_MAX_TOKENS,
  };
  try {
    return await client.chat.completions.create({
      ...request,
      response_format: { type: "json_object" },
    });
  } catch (error) {
    if (!isJsonModeUnsupported(error)) throw error;
    return client.chat.completions.create(request);
  }
}

async function generateDraft(client: LLMClient, model: string, prompt: string) {
  for (let attempt = 1; attempt <= FEEDBACK_MAX_ATTEMPTS; attempt += 1) {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
      max_tokens: FEEDBACK_MAX_TOKENS,
    });
    const content = response.choices[0]?.message?.content?.trim();
    if (content) return content;
  }
  throw new Error("LLM 返回空反馈内容，请重试");
}

async function reviewDraft(client: LLMClient, model: string, prompt: string) {
  for (let attempt = 1; attempt <= FEEDBACK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await createReviewCompletion(client, model, prompt);
      const content = response.choices[0]?.message?.content?.trim();
      if (content) return parseReviewPayload(content);
    } catch {
      // Retry once with the same evidence and stricter temperature before requiring manual review.
    }
  }
  return null;
}

export async function generateReviewedFeedback(
  input: GenerateReviewedFeedbackInput,
): Promise<ReviewedFeedback> {
  const draftFeedback = await generateFeedbackDraft({
    studentName: input.studentName,
    promptContext: input.promptContext,
    lengthRequirement: input.lengthRequirement,
    client: input.draftClient,
    model: input.draftModel,
  });
  return reviewFeedbackDraft({
    studentName: input.studentName,
    promptContext: input.promptContext,
    forbiddenStudentNames: input.forbiddenStudentNames,
    lengthRequirement: input.lengthRequirement,
    draftFeedback,
    client: input.reviewClient,
    model: input.reviewModel,
  });
}

export async function generateFeedbackDraft(input: FeedbackDraftInput) {
  const draftPrompt = `你是 Student Track 的内部反馈分析模型。请严格依据以下确定性背景，为${input.studentName}生成一份仅供后续成稿模型使用的内部分析草稿，不要写成给家长直接发送的话术。

${input.promptContext}

分析要求：
1. 不要复述整份课程母版。提炼一个最值得告诉家长的积极表现、一个具体问题和一个课后动作。
2. 最近两次只与个人本学期整体和对应课次班均对照；不得做“前两次 vs 最近两次”，也不得改写成“比学期初、比以前、一开始时更好”，不得写排名。
3. 个人 PDF 中的题数、正确率、知识点和答案是本次客观证据；单道错题不得扩张成长期能力判断。
4. 从历史评价、助教备注和事件中寻找真实的努力、习惯或方法信号，例如连续主动回答、开始记录步骤、愿意订正、由提示后完成到独立完成。一次行为只能写“本次出现”，重复行为可写“最近连续出现”或“正在形成”；没有方向性对照时不得写“越来越、明显提升、比以前更”。
5. 只有同一能力的前后证据或明确 T1/T2/T3 结果才能写“从不会到会”“已经掌握”“形成习惯”；否则只能描述本次结果和正在出现的积极信号。
6. 家校沟通已按实际发生时间由近到远排列。优先使用最接近本课且尚未解决的关切或承诺；较旧内容只作背景，若已被更新沟通取代则忽略。若家长曾担心成绩、难度、信心、方法或作业，应寻找本次可以回应该关切的证据；无相关证据或沟通只是收悉、请假、排课时，不要强行使用。
7. 所有背景都要区分“事实”“有边界的成长解读”和“建议”。成长解读要帮助家长理解孩子正在吸收什么、哪种方法正在建立，但不能拔高或许诺结果。
8. 课后动作必须具体到顺序、题号或材料以及完成标准；不要只写“订正巩固”“加强复习”。
9. 只分析该生本人，不比较、不提其他学生姓名，不补充背景中不存在的成绩、考勤、事件或家校结论。
10. 控制在 160–260 字，可分点；不要使用家长称呼、寒暄或可直接发送的结尾。最终家长话术将由下一阶段生成，目标长度为${input.lengthRequirement}。`;
  return generateDraft(input.client, input.model, draftPrompt);
}

export async function reviewFeedbackDraft(input: FeedbackReviewInput): Promise<ReviewedFeedback> {
  const draftFeedback = input.draftFeedback;
  const forbiddenNames = [...new Set((input.forbiddenStudentNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name && name !== input.studentName))];
  const reviewPrompt = `你是 Student Track 的反馈成稿与审核模型。请先逐项对照“确定性反馈背景”复核内部分析草稿，再把可靠内容改写成可以直接发给家长的话术。内部分析只是辅助材料，不是新的事实来源。

确定性反馈背景：
${input.promptContext}

内部分析草稿（仅供参考，不得原样发送）：
${draftFeedback}

成稿与审核规则：
1. 学生身份、本次表现、近期趋势、考勤、事件和家校沟通都必须能在确定性背景中找到依据；分析草稿与背景冲突时以背景为准。
2. 写成老师课后单独发给家长的微信，不写成学习报告。用4—5个自然短句形成“小成长叙事”：本次具体表现—相对个人历史的变化或稳定—这说明哪种知识、方法或习惯正在建立—一个仍需处理的问题—具体课后动作。
3. 家长读完应得到三种真实感受：老师确实观察到了我的孩子；孩子的努力和变化被看见；当前问题具体且下一步可控。情绪价值来自降低不确定感和看见真实努力，不来自空泛夸奖、制造焦虑或承诺提分。
4. 不使用 A/B/C/D 等系统字段代号，不比较或提到其他学生，不把建议写成已经发生的事实。
5. 公共课程材料不得被写成个体掌握结论；出门测统一说明中的“有错误、表现好”等模板判断不得作为证据。
6. 不输出排名；允许说“最近两次处在个人本学期较好水平”或“本次与同期整体接近”，但不得将全学期常态对照改写为“比学期初、比以前更好”，不要制造竞争和焦虑。
7. 不要照抄或近义改写群反馈，不要罗列完整课堂内容。课程主题最多用半句话交代，除非它是理解个体错题所必需的背景。
8. 禁用“整体表现优异”“值得肯定”“后续请关注”“订正巩固”“巩固学习效果”“如有疑问可随时联系老师”等成套 AI 话术。可以直接、口语化，但不要油腻或夸张。
9. 只有明确的前后证据才可写“从不会到会”“已经掌握”“越来越”“明显提升”“习惯已经形成”。若证据只是本次答题和重复出现的积极事件，应写“这次已经能……”“最近几节课都……”“这种做法正在慢慢稳定下来”。
10. 家校沟通按实际发生时间由近到远提供。优先回应最近且仍有效的学习关切或教师承诺；旧内容与新内容冲突时以新内容为准。可用本次证据自然回应，例如“您之前提到他觉得开始变难，这次……”。与学习无关的收悉、请假、排课和寒暄不得进入反馈。
11. 有题号和相似练习时，最后约三分之一篇幅写清“先不看答案重做具体题目并写判断依据—再做相似题—怎样算过关—仍不会再看讲解/提问”；不得凭空编造题目内容。没有个体证据时不要伪造任务。
12. 最终 feedback 应满足${input.lengthRequirement}，语气温和、具体、连贯，适合直接发送；不要标题、项目符号或内部分析措辞。
13. 分析可靠且已成功成稿时 verdict="pass"；需要删改分析中的不可靠内容但仍能安全成稿时 verdict="revise"；无法可靠成稿时 verdict="needs_review"。
14. 无论 pass 还是 revise 都必须返回完整最终 feedback；needs_review 可返回一份供教师修改的保守文本，并在 issues 中说明原因。
15. 只返回合法 JSON：{"verdict":"pass|revise|needs_review","feedback":"最终文本","issues":["简短原因"]}。`;
  const reviewed = await reviewDraft(input.client, input.model, reviewPrompt);
  if (!reviewed) {
    return {
      draftFeedback,
      feedback: "",
      reviewStatus: "needs_review",
      reviewIssues: ["成稿模型连续两次未返回合法结果，内部分析未作为家长话术使用"],
    };
  }

  let reviewStatus = normalizeVerdict(reviewed.verdict);
  const reviewIssues = normalizeIssues(reviewed.issues);
  const revisedFeedback = typeof reviewed.feedback === "string" ? reviewed.feedback.trim() : "";
  let feedback = revisedFeedback;
  if (!revisedFeedback) {
    reviewStatus = "needs_review";
    reviewIssues.push("成稿模型没有返回可发送的最终文本");
  }
  if (reviewStatus === "needs_review" && reviewIssues.length === 0) {
    reviewIssues.push("审核模型认为该反馈需要人工确认");
  }
  const mentionedOtherStudent = forbiddenNames.find((name) => feedback.includes(name));
  if (mentionedOtherStudent) {
    reviewStatus = "needs_review";
    reviewIssues.push("反馈中出现了其他学生姓名");
    feedback = "";
  }

  return {
    draftFeedback,
    feedback,
    reviewStatus,
    reviewIssues: [...new Set(reviewIssues)],
  };
}
