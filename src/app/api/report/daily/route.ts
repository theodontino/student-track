import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLLMClient, getLLMModel } from "@/lib/llm";

// POST /api/report/daily — 按课次生成班级日报
export async function POST(request: NextRequest) {
  try {
    const { sessionCode } = await request.json();
    if (!sessionCode) {
      return NextResponse.json({ error: "缺少课次编码" }, { status: 400 });
    }

    const session = await prisma.classSession.findUnique({ where: { code: sessionCode } });
    if (!session) return NextResponse.json({ error: "课次不存在" }, { status: 404 });

    const className = session.class;
    if (!className) return NextResponse.json({ error: "该课次未关联班级" }, { status: 400 });

    const students = await prisma.student.findMany({
      where: { class: className },
      select: { id: true, name: true },
    });
    if (students.length === 0) return NextResponse.json({ error: "该班级无学生" }, { status: 404 });

    const studentIds = students.map((s) => s.id);

    const [metrics, attendances] = await Promise.all([
      prisma.dailyMetric.findMany({
        where: { studentId: { in: studentIds }, sessionId: session.id },
      }),
      prisma.attendance.findMany({
        where: { sessionId: session.id, studentId: { in: studentIds } },
      }),
    ]);

    const events = await prisma.event.findMany({
      where: { studentId: { in: studentIds }, date: session.date },
    });

    const metricMap = new Map(metrics.map((m) => [m.studentId, m]));
    const attMap = new Map(attendances.map((a) => [a.studentId, a.present]));

    const studentLines = students.map((s) => {
      const m = metricMap.get(s.id);
      const present = attMap.get(s.id);
      const evts = events.filter((e) => e.studentId === s.id);
      const scores = m ? `A${m.scoreA}/B${m.scoreB}/C${m.scoreC}/D${m.scoreD}` : "无评分";
      const att = present === undefined ? "无考勤" : present ? "出勤" : "缺勤";
      const evt = evts.map((e) => e.description).join("；") || "无";
      return `${s.name}: ${scores} | ${att} | ${evt}`;
    });

    const prompt = `你是高中班主任助手。以下是${className}在${session.date}第${session.semesterNumber}次课（${sessionCode}）的学生数据，请生成一段200-300字班级日报。
客观、简洁、有重点。突出优秀和需关注的学生。

${studentLines.join("\n")}

请直接返回日报文本，不要附带标题或markdown。`;

    const client = createLLMClient();
    const model = getLLMModel();
    const resp = await client.chat.completions.create({
      model, messages: [{ role: "user", content: prompt }],
      temperature: 0.5, max_tokens: 1024,
    });
    const report = resp.choices[0]?.message?.content?.trim() || "";

    return NextResponse.json({ report, sessionCode, className, date: session.date, studentCount: students.length });
  } catch (error) {
    console.error("POST /api/report/daily error:", error);
    return NextResponse.json({ error: "生成日报失败" }, { status: 500 });
  }
}
