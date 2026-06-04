import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseInput, reviewParsed, correctNames } from "@/lib/parser";

export async function POST(request: NextRequest) {
  try {
    const { rawText } = await request.json();

    if (!rawText || rawText.trim().length === 0) {
      return NextResponse.json({ error: "请输入文本内容" }, { status: 400 });
    }

    // Get all student names for entity matching
    const students = await prisma.student.findMany({
      select: { name: true },
    });
    const studentNames = students.map((s) => s.name);

    // Step 1: LLM parse
    let parsedResult = await parseInput(rawText, studentNames);

    // v0.5: fuzzy-correct student names to exact DB names
    parsedResult = correctNames(parsedResult, studentNames);

    // Step 2: LLM self-review
    let reviewResult = null;
    try {
      reviewResult = await reviewParsed(rawText, parsedResult);
    } catch (reviewError) {
      console.error("LLM self-review failed:", reviewError);
      // Continue without review - teacher will still review manually
    }

    // Step 3: Save as draft
    const draft = await prisma.draftRecord.create({
      data: {
        rawText,
        parsedResult: JSON.stringify(parsedResult),
        reviewResult: reviewResult ? JSON.stringify(reviewResult) : null,
        status: "pending",
      },
    });

    return NextResponse.json({
      draftId: draft.id,
      rawText: draft.rawText,
      parsedResult,
      reviewResult,
      status: draft.status,
      createdAt: draft.createdAt,
    });
  } catch (error) {
    console.error("POST /api/input/parse error:", error);
    return NextResponse.json({ error: "LLM 解析失败，请稍后重试" }, { status: 500 });
  }
}
