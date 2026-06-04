import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import * as XLSX from "xlsx";

// POST /api/report/feedback-batch — 按课次批量生成全班家校反馈 + Excel 导出
export async function POST(request: NextRequest) {
  try {
    const { sessionCode } = await request.json();
    if (!sessionCode) return NextResponse.json({ error: "缺少课次编码" }, { status: 400 });

    const session = await prisma.classSession.findUnique({ where: { code: sessionCode } });
    if (!session) return NextResponse.json({ error: "课次不存在" }, { status: 404 });

    const className = session.class;
    if (!className) return NextResponse.json({ error: "该课次未关联班级" }, { status: 400 });

    const students = await prisma.student.findMany({
      where: { class: className },
      select: { id: true, name: true },
    });
    if (students.length === 0) return NextResponse.json({ error: "该班级无学生" }, { status: 404 });

    const [metrics, attendances] = await Promise.all([
      prisma.dailyMetric.findMany({
        where: { sessionId: session.id, studentId: { in: students.map((s) => s.id) } },
      }),
      prisma.attendance.findMany({
        where: { sessionId: session.id, studentId: { in: students.map((s) => s.id) } },
      }),
    ]);
    const events = await prisma.event.findMany({
      where: { date: session.date, studentId: { in: students.map((s) => s.id) } },
    });

    const metricMap = new Map(metrics.map((m) => [m.studentId, m]));
    const attMap = new Map(attendances.map((a) => [a.studentId, a.present]));

    const client = createLLMClient();
    const model = getLLMModel();
    const results: { name: string; feedback: string }[] = [];

    for (const s of students) {
      const m = metricMap.get(s.id);
      const present = attMap.get(s.id);
      const evts = events.filter((e) => e.studentId === s.id);

      const context = `${s.name}在${session.date}第${session.semesterNumber}次课：
学习A:${m?.scoreA??"—"} 纪律B:${m?.scoreB??"—"} 作业C:${m?.scoreC??"—"} 考勤D:${m?.scoreD??"—"}
出勤:${present===undefined?"无记录":present?"到课":"缺勤"}
事件:${evts.map(e=>e.description).join("；")||"无"}`;

      try {
        const resp = await client.chat.completions.create({
          model, messages: [{ role: "user", content: `${context}\n\n请为${s.name}生成一段50-80字家校反馈，温和客观，直接返回文本。` }],
          temperature: 0.5, max_tokens: 256,
        });
        results.push({ name: s.name, feedback: resp.choices[0]?.message?.content?.trim() || "" });
      } catch {
        results.push({ name: s.name, feedback: "[生成失败]" });
      }
    }

    // Check if client wants JSON or Excel
    const acceptExcel = request.headers.get("accept") === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (acceptExcel) {
      const rows = results.map((r) => ({ 姓名: r.name, 家校反馈: r.feedback }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "家校反馈");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      return new NextResponse(new Uint8Array(buf), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="反馈_${className}_${sessionCode}.xlsx"`,
        },
      });
    }

    return NextResponse.json({ results, sessionCode, className });
  } catch (error) {
    console.error("POST /api/report/feedback-batch error:", error);
    return NextResponse.json({ error: "批量生成失败" }, { status: 500 });
  }
}
