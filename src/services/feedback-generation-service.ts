import type { createLLMClient } from "@/lib/llm";

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
  const draftPrompt = `你是 Chem-Track 的内部反馈分析模型。请严格依据以下确定性背景，为${input.studentName}生成一份仅供后续成稿模型使用的内部分析草稿，不要写成给家长直接发送的话术。

${input.promptContext}

分析要求：
1. 先概括本次课有记录支持的表现，再结合近期课次判断稳定、改善、波动或暂时缺少趋势依据。
2. 将历史事件和家校沟通作为背景线索，区分“已发生事实”和“后续建议”，不得把建议写成事实。
3. 提炼 1–2 个适合对家长表达的重点；没有足够记录时明确写“依据不足”，不要硬做趋势结论。
4. 只分析该生本人，不比较、不提其他学生姓名，不补充背景中不存在的成绩、考勤、事件或家校结论。
5. 控制在 120–220 字，可分点；不要使用家长称呼、寒暄或可直接发送的结尾。最终家长话术将由下一阶段生成，目标长度为${input.lengthRequirement}。`;
  return generateDraft(input.client, input.model, draftPrompt);
}

export async function reviewFeedbackDraft(input: FeedbackReviewInput): Promise<ReviewedFeedback> {
  const draftFeedback = input.draftFeedback;
  const forbiddenNames = [...new Set((input.forbiddenStudentNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name && name !== input.studentName))];
  const reviewPrompt = `你是 Chem-Track 的反馈成稿与审核模型。请先逐项对照“确定性反馈背景”复核内部分析草稿，再把可靠内容改写成可以直接发给家长的话术。内部分析只是辅助材料，不是新的事实来源。

确定性反馈背景：
${input.promptContext}

内部分析草稿（仅供参考，不得原样发送）：
${draftFeedback}

成稿与审核规则：
1. 学生身份、本次表现、近期趋势、考勤、事件和家校沟通都必须能在确定性背景中找到依据；分析草稿与背景冲突时以背景为准。
2. 家长话术先写本次表现，再自然带出有依据的趋势或历史联系，最后给出一条可执行但不过度承诺的建议。
3. 不使用 A/B/C/D 等系统字段代号，不比较或提到其他学生，不把建议写成已经发生的事实。
4. 最终 feedback 应满足${input.lengthRequirement}，语气温和、具体、连贯，适合直接发送；不要标题、项目符号或内部分析措辞。
5. 分析可靠且已成功成稿时 verdict="pass"；需要删改分析中的不可靠内容但仍能安全成稿时 verdict="revise"；无法可靠成稿时 verdict="needs_review"。
6. 无论 pass 还是 revise 都必须返回完整最终 feedback；needs_review 可返回一份供教师修改的保守文本，并在 issues 中说明原因。
7. 只返回合法 JSON：{"verdict":"pass|revise|needs_review","feedback":"最终文本","issues":["简短原因"]}。`;
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
