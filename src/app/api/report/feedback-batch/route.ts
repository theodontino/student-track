import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import * as XLSX from "xlsx";

// In-memory cache: sessionCode → { buffer, timestamp, total }
const cache = new Map<string, { buffer: Uint8Array; timestamp: number; total: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 min

// GET /api/report/feedback-batch?sessionCode=xxx — 下载缓存的 Excel
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("sessionCode");
  if (!code) return NextResponse.json({ error: "缺少参数" }, { status: 400 });

  const cached = cache.get(code);
  if (!cached) return NextResponse.json({ error: "无缓存，请先生成" }, { status: 404 });
  if (Date.now() - cached.timestamp > CACHE_TTL) { cache.delete(code); return NextResponse.json({ error: "缓存已过期" }, { status: 410 }); }

  return new Response(cached.buffer as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="feedback_${code}.xlsx"`,
    },
  });
}

// POST /api/report/feedback-batch — 批量生成（NDJSON 流式 + 后端缓存）
export async function POST(request: NextRequest) {
  try {
    const { sessionCode } = await request.json();
    if (!sessionCode) return NextResponse.json({ error: "缺少课次编码" }, { status: 400 });

    // Check cache — if valid, return JSON (no need to re-stream)
    const cached = cache.get(sessionCode);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json({ cached: true, total: cached.total, sessionCode });
    }

    const session = await prisma.classSession.findUnique({ where: { code: sessionCode } });
    if (!session) return NextResponse.json({ error: "课次不存在" }, { status: 404 });
    const className = session.class;
    if (!className) return NextResponse.json({ error: "该课次未关联班级" }, { status: 400 });

    const students = await prisma.student.findMany({
      where: { class: className },
      select: { id: true, name: true, labels: true },
    });
    if (students.length === 0) return NextResponse.json({ error: "该班级无学生" }, { status: 404 });

    const [metrics, attendances] = await Promise.all([
      prisma.dailyMetric.findMany({ where: { sessionId: session.id, studentId: { in: students.map(s => s.id) } } }),
      prisma.attendance.findMany({ where: { sessionId: session.id, studentId: { in: students.map(s => s.id) } } }),
    ]);
    // Events: date-based (no sessionId on Event model). On same-day multi-session,
    // events from other sessions may appear. Prompt below constrains cross-referencing.
    const events = await prisma.event.findMany({ where: { date: session.date, studentId: { in: students.map(s => s.id) } } });

    const metricMap = new Map(metrics.map(m => [m.studentId, m]));
    const attMap = new Map(attendances.map(a => [a.studentId, a.present]));

    const client = createLLMClient();
    const model = getLLMModel();
    const total = students.length;

    const encoder = new TextEncoder();

    // Build init payload: all students with labels
    const studentCards = students.map(s => ({
      id: s.id,
      name: s.name,
      labels: JSON.parse(s.labels) as string[],
    }));

    const stream = new ReadableStream({
      async start(controller) {
        // Send init with all student info (NDJSON: one JSON per line)
        controller.enqueue(encoder.encode(JSON.stringify({ type: "init", students: studentCards, total }) + "\n"));

        const results: { name: string; feedback: string }[] = [];

        for (const s of students) {
          const m = metricMap.get(s.id);
          const present = attMap.get(s.id);
          const evts = events.filter(e => e.studentId === s.id);
          const eventText = evts.map(e => e.description).join("；") || "无";

          const ctx =
            `A:${m?.scoreA ?? "—"} B:${m?.scoreB ?? "—"} C:${m?.scoreC ?? "—"} D:${m?.scoreD ?? "—"} ` +
            `出勤:${present === undefined ? "无" : present ? "到" : "缺"} ` +
            (eventText !== "无" ? `事件:${eventText}` : "");

          const prompt = `${s.name}，${session.date}第${session.semesterNumber}次课。${ctx}\n\n请为${s.name}生成50-80字家校反馈，只反馈该生本人表现，不比较、不提其他学生姓名。温和客观，直接返回。`;

          let feedback: string;
          try {
            const resp = await client.chat.completions.create({
              model, messages: [{ role: "user", content: prompt }],
              temperature: 0.5, max_tokens: 256,
            });
            feedback = resp.choices[0]?.message?.content?.trim() || "";
          } catch { feedback = "[失败]"; }

          results.push({ name: s.name, feedback });

          // Stream progress (NDJSON: one JSON per line)
          controller.enqueue(encoder.encode(JSON.stringify({ type: "progress", studentId: s.id, feedback }) + "\n"));
        }

        // Build Excel and cache
        const rows = results.map(r => ({ 姓名: r.name, 家校反馈: r.feedback }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "家校反馈");
        const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
        cache.set(sessionCode, { buffer: new Uint8Array(buf), timestamp: Date.now(), total });

        // Send done (NDJSON)
        controller.enqueue(encoder.encode(JSON.stringify({ type: "done", sessionCode, total, className }) + "\n"));
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("POST /api/report/feedback-batch error:", error);
    return NextResponse.json({ error: "批量生成失败" }, { status: 500 });
  }
}
