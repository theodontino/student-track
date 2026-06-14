import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseInput, reviewParsed, correctNames, llmCallStream, correctNamesWithLLM } from "@/lib/parser";
import { SYSTEM_PROMPT } from "@/lib/prompts";
import { completeClassAttendance } from "@/lib/nlAttendance";

export async function POST(request: NextRequest) {
  try {
    const { rawText, sessionCode } = await request.json();

    if (!rawText || rawText.trim().length === 0) {
      return NextResponse.json({ error: "请输入文本内容" }, { status: 400 });
    }
    if (!sessionCode) {
      return NextResponse.json({ error: "请选择课次，系统需要据此判定未提及学生为缺勤" }, { status: 400 });
    }

    // v0.13: SSE stream mode
    const streamMode = new URL(request.url).searchParams.get("stream") === "true";

    const session = await prisma.classSession.findUnique({
      where: { code: sessionCode },
      select: { classId: true },
    });
    if (!session) return NextResponse.json({ error: "课次不存在" }, { status: 404 });
    if (!session.classId) return NextResponse.json({ error: "该课次未关联班级，无法补齐考勤" }, { status: 400 });

    // Name matching and absence completion must stay inside the selected class.
    const students = await prisma.student.findMany({
      where: { classId: session.classId },
      select: { id: true, name: true },
      orderBy: { studentId: "asc" },
    });
    const studentNames = students.map((s) => s.name);

    // v0.13: SSE stream mode — send tokens as they arrive
    if (streamMode) {
      const encoder = new TextEncoder();
      const sseStream = new ReadableStream({
        async start(controller) {
          try {
            // Step 0: Name correction via LLM
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", message: "正在修正姓名…" })}\n\n`));
            const nameFix = await correctNamesWithLLM(rawText, studentNames);
            const fixedText = nameFix.correctedText;
            const corrections = nameFix.corrections;

            const userPrompt = `已知学生名单：${studentNames.join("、")}

教师的输入文本：
${fixedText}

请按照 System Prompt 的要求，分析文本并返回 JSON。`;

            let content = "";
            await llmCallStream([
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ], 0.3, (delta) => {
              content += delta;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "chunk", content: delta })}\n\n`));
            });

            // Parse JSON from LLM response
            let cleaned = content.trim();
            if (cleaned.startsWith("```")) {
              cleaned = cleaned.replace(/```\w*\n?/, "").replace(/\n?```$/, "");
            }
            let parsedResult = JSON.parse(cleaned);
            parsedResult = correctNames(parsedResult, studentNames);

            // Review only the content inferred by the LLM. Attendance completion is deterministic.
            let reviewResult = null;
            try { reviewResult = await reviewParsed(rawText, parsedResult); } catch {}
            parsedResult = completeClassAttendance(parsedResult, students);

            const nameToId = new Map(students.map((s) => [s.name, s.id]));
            const matchedStudentIds = parsedResult.students
              .map((stu: any) => nameToId.get(stu.name) ?? null)
              .filter(Boolean) as string[];

            // Save draft
            const draft = await prisma.draftRecord.create({
              data: {
                rawText: fixedText,
                parsedResult: JSON.stringify(parsedResult),
                reviewResult: reviewResult ? JSON.stringify(reviewResult) : null,
                status: "pending",
                sessionCode,
                studentId: matchedStudentIds[0] ?? null,
              },
            });

            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: "result", draftId: draft.id, parsedResult, reviewResult, corrections })}\n\n`
            ));
            controller.close();
          } catch (e: any) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: "error", message: e.message })}\n\n`
            ));
            controller.close();
          }
        },
      });
      return new NextResponse(sseStream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    // v0.13: Step 0 — correct names via LLM before parsing
    const nameFix = await correctNamesWithLLM(rawText, studentNames);
    const fixedText = nameFix.correctedText;
    const corrections = nameFix.corrections;

    // Step 1: LLM parse
    let parsedResult = await parseInput(fixedText, studentNames);

    // v0.5: fuzzy-correct student names to exact DB names
    parsedResult = correctNames(parsedResult, studentNames);

    // Self-review before deterministic roster completion.
    let reviewResult = null;
    try {
      reviewResult = await reviewParsed(rawText, parsedResult);
    } catch (reviewError) {
      console.error("LLM self-review failed:", reviewError);
    }

    parsedResult = completeClassAttendance(parsedResult, students);

    // v0.10: match students by corrected name to get studentId
    const nameToId = new Map(students.map((s) => [s.name, s.id]));
    const matchedStudentIds = parsedResult.students
      .map((stu) => nameToId.get(stu.name) ?? null)
      .filter(Boolean) as string[];

    // Step 3: Save as draft
    const draft = await prisma.draftRecord.create({
      data: {
        rawText,
        parsedResult: JSON.stringify(parsedResult),
        reviewResult: reviewResult ? JSON.stringify(reviewResult) : null,
        status: "pending",
        sessionCode,
        studentId: matchedStudentIds[0] ?? null,  // v0.10: store primary matched studentId
      },
    });

    return NextResponse.json({
      draftId: draft.id,
      rawText: draft.rawText,
      parsedResult,
      reviewResult,
      status: draft.status,
      sessionCode: draft.sessionCode,
      createdAt: draft.createdAt,
      corrections,
    });
  } catch (error) {
    console.error("[/api/input/parse] error:", error);
    return NextResponse.json({ error: "LLM 解析失败，请稍后重试" }, { status: 500 });
  }
}
