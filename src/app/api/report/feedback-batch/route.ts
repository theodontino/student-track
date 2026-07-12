import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import {
  buildFeedbackContext,
  type FeedbackContextPreview,
  type FeedbackContextStudent,
} from "@/services/feedback-context-service";
import { buildFeedbackExportWorkbook } from "@/services/feedback-export-service";
import { getAlertDashboard } from "@/services/alert-service";

type HistoryModule = "feedback" | "report";
interface FeedbackCard {
  id: string;
  name: string;
  labels: string[];
  feedback: string;
  contextPreview?: FeedbackContextPreview;
}
interface FeedbackState {
  kind: "batch";
  semesterId: string;
  sessionCode: string;
  className: string;
  students: FeedbackCard[];
  total: number;
}

const cache = new Map<string, { timestamp: number; state: FeedbackState }>();
const CACHE_TTL = 30 * 60 * 1000;
const FEEDBACK_MAX_TOKENS = 2048;
const FEEDBACK_MAX_ATTEMPTS = 2;

function moduleFrom(value: unknown): HistoryModule | null {
  if (value === undefined || value === null || value === "report") return "report";
  if (value === "feedback") return "feedback";
  return null;
}

function cacheKey(module: HistoryModule, sessionCode: string) {
  return `${module}:${sessionCode}`;
}

async function generateFeedbackText(
  client: ReturnType<typeof createLLMClient>,
  model: string,
  prompt: string
) {
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

function parseHistoryState(value: string): FeedbackState | null {
  try {
    const state = JSON.parse(value);
    return Array.isArray(state?.students) ? state : null;
  } catch { return null; }
}

function submittedCardsFrom(
  value: unknown,
  contextByStudent: Map<string, FeedbackContextStudent>
): FeedbackCard[] | null {
  if (!Array.isArray(value)) return null;

  const cards: FeedbackCard[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = "id" in item ? item.id : undefined;
    if (typeof id !== "string") continue;

    const student = contextByStudent.get(id);
    if (!student) continue;

    const feedback = "feedback" in item && typeof item.feedback === "string"
      ? item.feedback.trim()
      : "";
    cards.push({
      id: student.id,
      name: student.name,
      labels: student.labels,
      feedback,
      contextPreview: student.preview,
    });
  }

  return cards;
}

// GET /api/report/feedback-batch?sessionCode=xxx&module=feedback
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionCode = searchParams.get("sessionCode");
  const historyModule = moduleFrom(searchParams.get("module"));
  if (!sessionCode) return NextResponse.json({ error: "缺少参数" }, { status: 400 });
  if (!historyModule) return NextResponse.json({ error: "无效的历史模块" }, { status: 400 });

  const key = cacheKey(historyModule, sessionCode);
  let state: FeedbackState | null = null;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    state = cached.state;
  } else {
    if (cached) cache.delete(key);
    const history = await prisma.workHistory.findFirst({
      where: { module: historyModule, key: sessionCode },
      orderBy: { createdAt: "desc" },
    });
    state = history ? parseHistoryState(history.state) : null;
  }

  if (!state) return NextResponse.json({ error: "尚未生成反馈" }, { status: 404 });
  const dashboard = await getAlertDashboard({ semesterId: state.semesterId });
  const buffer = await buildFeedbackExportWorkbook(
    prisma,
    sessionCode,
    state.students,
    dashboard.studentAlerts,
  );
  return new Response(buffer as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="feedback_${sessionCode}.xlsx"`,
    },
  });
}

// POST /api/report/feedback-batch — NDJSON streaming with persistent result history.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sessionCode = body.sessionCode as string | undefined;
    const historyModule = moduleFrom(body.historyModule);
    const bypassCache = body.bypassCache === true;
    const saveState = body.saveState === true;
    if (!sessionCode) return NextResponse.json({ error: "缺少课次编码" }, { status: 400 });
    if (!historyModule) return NextResponse.json({ error: "无效的历史模块" }, { status: 400 });

    const key = cacheKey(historyModule, sessionCode);
    const cached = cache.get(key);
    if (!saveState && !bypassCache && cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json({ cached: true, ...cached.state });
    }

    const feedbackContext = await buildFeedbackContext(prisma, sessionCode);
    const contextByStudent = new Map(feedbackContext.students.map((student) => [student.id, student]));

    if (saveState) {
      const cards = submittedCardsFrom(body.students, contextByStudent);
      if (!cards || cards.length === 0) {
        return NextResponse.json({ error: "没有可保存的反馈内容" }, { status: 400 });
      }

      const state: FeedbackState = {
        kind: "batch",
        semesterId: feedbackContext.session.semesterId,
        sessionCode,
        className: feedbackContext.className,
        students: cards,
        total: cards.length,
      };
      cache.set(key, { timestamp: Date.now(), state });
      await prisma.workHistory.create({
        data: {
          module: historyModule,
          key: sessionCode,
          title: `${feedbackContext.className} ${sessionCode} 保存反馈`,
          state: JSON.stringify(state),
        },
      });

      return NextResponse.json({ saved: true, ...state });
    }

    const client = createLLMClient();
    const model = getLLMModel();
    const total = feedbackContext.total;
    const cards: FeedbackCard[] = feedbackContext.students.map((student) => ({
      id: student.id,
      name: student.name,
      labels: student.labels,
      feedback: "",
      contextPreview: student.preview,
    }));
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "init", students: cards, total }) + "\n"));

          for (const card of cards) {
            const studentContext = contextByStudent.get(card.id);
            const prompt = `${studentContext?.promptContext ?? card.name}\n\n请为${card.name}生成50-80字家校反馈，只反馈该生本人表现，不比较、不提其他学生姓名。温和客观，直接返回。`;

            try {
              card.feedback = await generateFeedbackText(client, model, prompt);
            } catch (error) {
              console.error(`[feedback-batch] ${card.name} failed:`, error);
              card.feedback = "[生成失败，请重试]";
            }

            controller.enqueue(encoder.encode(JSON.stringify({
              type: "progress",
              studentId: card.id,
              name: card.name,
              feedback: card.feedback,
            }) + "\n"));
          }

          const state: FeedbackState = {
            kind: "batch",
            semesterId: feedbackContext.session.semesterId,
            sessionCode,
            className: feedbackContext.className,
            students: cards,
            total,
          };
          cache.set(key, { timestamp: Date.now(), state });
          await prisma.workHistory.create({
            data: {
              module: historyModule,
              key: sessionCode,
              title: `${feedbackContext.className} ${sessionCode} 批量反馈`,
              state: JSON.stringify(state),
            },
          });

          controller.enqueue(encoder.encode(JSON.stringify({ type: "done", ...state }) + "\n"));
          controller.close();
        } catch (error) {
          console.error("[/api/report/feedback-batch] stream error:", error);
          controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message: "批量生成失败" }) + "\n"));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("[/api/report/feedback-batch] error:", error);
    return NextResponse.json({ error: "批量生成失败" }, { status: 500 });
  }
}
