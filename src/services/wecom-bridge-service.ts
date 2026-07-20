import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { createLLMClient, getLLMModel } from "@/lib/llm";

export interface GenerateWeComBridgeInput {
  sourceText?: string;
  exportPath?: string;
  candidateStudentIds?: string[];
}

export interface GenerateWeComBridgeResult {
  sourceLabel: string;
  bridgeJson: unknown;
  rawOutput: string;
}

interface GenerateWeComBridgeOptions {
  onRetry?: () => void;
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonObject(text: string) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("LLM 未返回合法 JSON");
  }
}

function isJsonModeUnsupported(error: unknown) {
  const candidate = error as { status?: number; message?: string };
  return [400, 404, 422].includes(candidate?.status ?? 0)
    && /response[_ -]?format|json[_ -]?object|json mode/i.test(candidate?.message || "");
}

async function createJsonCompletion(
  client: ReturnType<typeof createLLMClient>,
  model: string,
  prompt: string,
  temperature: number,
) {
  const request = {
    model,
    messages: [{ role: "user" as const, content: prompt }],
    temperature,
    max_tokens: 8192,
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

function extractBridgeJson(rawOutput: string) {
  if (!rawOutput) throw new Error("LLM 未返回企微候选 JSON");
  const bridgeJson = parseJsonObject(rawOutput);
  if (!Array.isArray((bridgeJson as { records?: unknown }).records)) {
    throw new Error("LLM 返回 JSON 缺少 records 数组");
  }
  return bridgeJson;
}

async function loadSource(input: GenerateWeComBridgeInput) {
  const sourceText = clean(input.sourceText);
  if (sourceText) return { text: sourceText, sourceLabel: "粘贴的企微文本" };

  const exportPath = clean(input.exportPath);
  if (!exportPath) throw new Error("缺少企微导出文本或文件路径");
  const resolvedPath = resolve(exportPath);
  return { text: await readFile(resolvedPath, "utf8"), sourceLabel: resolvedPath };
}

export async function generateWeComBridgeJson(
  prisma: PrismaClient,
  input: GenerateWeComBridgeInput,
  options: GenerateWeComBridgeOptions = {},
): Promise<GenerateWeComBridgeResult> {
  const { text, sourceLabel } = await loadSource(input);
  const candidateStudentIds = Array.isArray(input.candidateStudentIds)
    ? [...new Set(input.candidateStudentIds.filter((id) => typeof id === "string" && id.trim()))]
    : [];
  let roster: Array<{
    id: string;
    name: string;
    studentId: string;
    className: string;
    recentCommunications: string[];
  }>;
  if (candidateStudentIds.length > 0) {
    const students = await prisma.student.findMany({
      where: { id: { in: candidateStudentIds } },
      select: {
        id: true,
        name: true,
        studentId: true,
        class: { select: { name: true, code: true } },
        communications: {
          select: { summary: true },
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
      orderBy: { studentId: "asc" },
    });
    roster = students.map((student) => ({
      id: student.id,
      name: student.name,
      studentId: student.studentId,
      className: student.class?.name ?? student.class?.code ?? "",
      recentCommunications: student.communications.map((item) => item.summary),
    }));
  } else {
    const students = await prisma.student.findMany({
      select: {
        id: true,
        name: true,
        studentId: true,
        class: { select: { name: true, code: true } },
      },
      orderBy: { studentId: "asc" },
    });
    roster = students
      .filter((student) => student.name.trim() && text.includes(student.name.trim()))
      .map((student) => ({
        id: student.id,
        name: student.name,
        studentId: student.studentId,
        className: student.class?.name ?? student.class?.code ?? "",
        recentCommunications: [],
      }));
  }
  if (roster.length === 0) {
    throw new Error("未能从聊天内容中确定候选学生，请先补充学生姓名");
  }

  const clippedText = text.length > 24_000 ? text.slice(-24_000) : text;
  const prompt = `你是 Chem-Track 的企微家校沟通提取器。请从企微聊天导出中提取对“课后反馈”有长期价值、且能明确绑定到某个学生的家校沟通信息。

学生名单：
${JSON.stringify(roster, null, 2)}

输出要求：
1. 只返回合法 JSON，不要 Markdown，不要解释。
2. JSON 顶层格式必须是：
{
  "source": "wecomcatch",
  "mode": "candidateOnly",
  "records": []
}
3. 只生成 kind="communication" 的 records。
4. 如果不能明确匹配唯一学生，matchedStudent.confidence 填 "low"，不要臆测。
5. 没有明确课次时 sessionCode 填 null。
6. summaryForChemTrack 要写成适合 Chem-Track 入库的摘要，保留“家长关注点、学生状态、后续反馈口径或行动建议”。
7. feedbackContext.toneHint 和 nextAction 用于之后生成家长反馈，必须简短可执行。
8. 同时从文字事实识别内部关注信号 attentionSignals：
   - academic-performance：明确说成绩差、退步、跟不上；
   - learning-confidence：明确说没信心、自我否定、畏难；
   - parent-concern：家长明确表达担心、焦虑；
   - withdrawal-intent：学生或家长表达退班意向。
   每项必须包含 reason、confidence=high|medium|low、evidenceSummary。不要根据数字或模糊语气猜测；没有时输出 []。
9. 输入中如果提供了会话ID和消息ID，source.conversationId 必须照抄会话ID，source.messageIds 必须只包含支撑该记录的输入消息ID，不得编造。
10. 对照学生名单中的 recentCommunications：只是重复已有担心、状态或建议，没有新事实、新变化或新行动时不生成 record。

record 示例：
{
  "kind": "communication",
  "source": { "conversationId": null, "conversationTitle": "张三妈妈", "messageIds": [] },
  "matchedStudent": { "id": "学生id", "name": "张三", "studentId": "S001", "confidence": "high" },
  "occurredAt": "2026-07-04",
  "sessionCode": null,
  "target": "母亲",
  "summary": "原始沟通要点摘要",
  "summaryForChemTrack": "面向 Chem-Track 的家校沟通摘要",
  "feedbackContext": { "toneHint": "语气提示", "nextAction": "下一步建议" },
  "attentionSignals": [{ "reason": "parent-concern", "confidence": "high", "evidenceSummary": "家长明确担心近期学习状态" }],
  "confidence": "high"
}

企微导出内容：
${clippedText}`;

  const client = createLLMClient();
  const model = getLLMModel();
  const response = await createJsonCompletion(client, model, prompt, 0.1);
  let rawOutput = response.choices[0]?.message?.content?.trim() || "";
  try {
    const bridgeJson = extractBridgeJson(rawOutput);
    return { sourceLabel, bridgeJson, rawOutput };
  } catch {
    options.onRetry?.();
  }

  const retryPrompt = `${prompt}\n\n上一次输出未通过 JSON 语法校验。请重新完整提取，并严格检查逗号、引号、括号和字符串转义；只返回一个可被 JSON.parse 直接解析的完整 JSON 对象。`;
  const retryResponse = await createJsonCompletion(client, model, retryPrompt, 0);
  rawOutput = retryResponse.choices[0]?.message?.content?.trim() || "";
  try {
    const bridgeJson = extractBridgeJson(rawOutput);
    return { sourceLabel, bridgeJson, rawOutput };
  } catch {
    throw new Error("LLM 连续两次未返回合法的企微候选 JSON，该批次已停止且未写入数据库");
  }
}
