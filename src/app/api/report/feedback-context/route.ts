import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildFeedbackContext } from "@/services/feedback-context-service";
import { buildFeedbackRouting } from "@/services/feedback-intensity-service";

// GET /api/report/feedback-context?sessionCode=xxx
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionCode = searchParams.get("sessionCode");
    if (!sessionCode) return NextResponse.json({ error: "缺少课次编码" }, { status: 400 });

    const sessionIds = (searchParams.get("sessionIds") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 100);
    const context = await buildFeedbackContext(prisma, sessionCode, sessionIds.length ? { sessionIds } : undefined);
    const routing = await buildFeedbackRouting(prisma, context);
    return NextResponse.json({ ...context, routing });
  } catch (error: any) {
    const message = error.message || "读取反馈上下文失败";
    const status = ["课次不存在", "该课次未关联班级", "该班级无学生"].includes(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
