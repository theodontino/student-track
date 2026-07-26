import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseInput, reviewParsed, correctNames, llmCallStream, correctNamesWithLLM } from "@/lib/parser";
import { SYSTEM_PROMPT } from "@/lib/prompts";
import { completeClassAttendance } from "@/lib/nlAttendance";
import { withLLMCacheOperation } from "@/services/llm-cache-service";
import { DraftStructuredResultSchema, ParseRequestSchema } from "@/lib/contracts/classroom-parse";
import type { DraftStructuredResult } from "@/lib/types";
import { apiErrorBody, apiStreamErrorBody, ApiError } from "@/lib/api-errors";
import { ZodError } from "zod";

function parseError(error: unknown) {
  if (error instanceof ZodError) return new ApiError("LLM 输出未通过结构化校验", 502, "llm_schema_invalid", false);
  if (error instanceof Error && /LLM|模型|response|token/i.test(error.message)) {
    return new ApiError("LLM 服务暂时不可用", 502, "llm_service_error", true);
  }
  return new ApiError("课堂解析失败，请稍后重试", 500, "internal_error", false);
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    const input = ParseRequestSchema.safeParse(body);
    if (!input.success) return NextResponse.json({ error: "请输入有效的课堂文本和课次编码", code: "invalid_request", retryable: false }, { status: 400 });
    const { rawText, sessionCode } = input.data;

    // v0.13: SSE stream mode
    const streamMode = new URL(request.url).searchParams.get("stream") === "true";

    const session = await prisma.classSession.findUnique({
      where: { code: sessionCode },
      select: { classId: true },
    });
    if (!session) return NextResponse.json({ error: "课次不存在", code: "not_found", retryable: false }, { status: 404 });
    if (!session.classId) return NextResponse.json({ error: "该课次未关联班级，无法补齐考勤", code: "invalid_request", retryable: false }, { status: 400 });

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
            await withLLMCacheOperation("classroom-parse", "解析课堂记录", async () => {
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
              let parsedResult = DraftStructuredResultSchema.parse(JSON.parse(cleaned) as unknown) as DraftStructuredResult;
              parsedResult = correctNames(parsedResult, studentNames);

              // Review only the content inferred by the LLM. Attendance completion is deterministic.
              let reviewResult = null;
              const warnings: string[] = [];
              try { reviewResult = await reviewParsed(rawText, parsedResult); } catch { warnings.push("自动复核失败，请人工检查结构化记录。"); }
              parsedResult = completeClassAttendance(parsedResult, students);

              const nameToId = new Map(students.map((s) => [s.name, s.id]));
              const matchedStudentIds = parsedResult.students
                .map((student) => nameToId.get(student.name) ?? null)
                .filter((id): id is string => id !== null);

              // Save draft
              const draft = await prisma.draftRecord.create({
                data: {
                  rawText,
                  parsedResult: JSON.stringify(parsedResult),
                  reviewResult: reviewResult ? JSON.stringify(reviewResult) : null,
                  status: "pending",
                  sessionCode,
                  studentId: matchedStudentIds[0] ?? null,
                },
              });

              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: "result", draftId: draft.id, parsedResult, reviewResult, corrections, warnings })}\n\n`
              ));
            });
            controller.close();
          } catch (error: unknown) {
            const failure = parseError(error);
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: "error", ...apiStreamErrorBody(failure) })}\n\n`
            ));
            controller.close();
          }
        },
      });
      return new NextResponse(sseStream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    const result = await withLLMCacheOperation("classroom-parse", "解析课堂记录", async () => {
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
      const warnings: string[] = [];
      try {
        reviewResult = await reviewParsed(rawText, parsedResult);
      } catch { warnings.push("自动复核失败，请人工检查结构化记录。"); }

      parsedResult = completeClassAttendance(parsedResult, students);

    // v0.10: match students by corrected name to get studentId
      const nameToId = new Map(students.map((s) => [s.name, s.id]));
      const matchedStudentIds = parsedResult.students
        .map((stu) => nameToId.get(stu.name) ?? null)
        .filter((id): id is string => id !== null);

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

      return {
        draftId: draft.id,
        rawText: draft.rawText,
        parsedResult,
        reviewResult,
        status: draft.status,
        sessionCode: draft.sessionCode,
        createdAt: draft.createdAt,
        corrections,
        warnings,
      };
    });
    return NextResponse.json(result);
  } catch (error: unknown) {
    const failure = parseError(error);
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
