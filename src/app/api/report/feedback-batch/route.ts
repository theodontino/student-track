import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import {
  buildFeedbackContext,
  type FeedbackContextPreview,
  type FeedbackContextStudent,
} from "@/services/feedback-context-service";
import * as XLSX from "xlsx";

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

const cache = new Map<string, { buffer: Uint8Array; timestamp: number; state: FeedbackState }>();
const CACHE_TTL = 30 * 60 * 1000;

function moduleFrom(value: unknown): HistoryModule | null {
  if (value === undefined || value === null || value === "report") return "report";
  if (value === "feedback") return "feedback";
  return null;
}

function cacheKey(module: HistoryModule, sessionCode: string) {
  return `${module}:${sessionCode}`;
}

function buildWorkbook(students: FeedbackCard[]) {
  const rows = students.map((student) => ({ 姓名: student.name, 家校反馈: student.feedback }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "家校反馈");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
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
  let buffer: Uint8Array | null = null;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    buffer = cached.buffer;
  } else {
    if (cached) cache.delete(key);
    const history = await prisma.workHistory.findFirst({
      where: { module: historyModule, key: sessionCode },
      orderBy: { createdAt: "desc" },
    });
    const state = history ? parseHistoryState(history.state) : null;
    if (state) buffer = buildWorkbook(state.students);
  }

  if (!buffer) return NextResponse.json({ error: "尚未生成反馈" }, { status: 404 });
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
      const buffer = buildWorkbook(cards);
      cache.set(key, { buffer, timestamp: Date.now(), state });
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
              const response = await client.chat.completions.create({
                model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.5,
                max_tokens: 256,
              });
              card.feedback = response.choices[0]?.message?.content?.trim() || "[未生成内容]";
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
          const buffer = buildWorkbook(cards);
          cache.set(key, { buffer, timestamp: Date.now(), state });
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
