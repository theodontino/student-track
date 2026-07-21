import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createLLMClient, getLLMModel } from "@/lib/llm";
import { buildFeedbackContext } from "@/services/feedback-context-service";
import { generateReviewedFeedback } from "@/services/feedback-generation-service";
import {
  markCurrentLLMCacheOperationIncomplete,
  withLLMCacheOperation,
} from "@/services/llm-cache-service";

async function reviewedFeedback(
  studentName: string,
  promptContext: string,
  lengthRequirement: string,
  forbiddenStudentNames: string[] = [],
) {
  return generateReviewedFeedback({
    studentName,
    promptContext,
    forbiddenStudentNames,
    lengthRequirement,
    draftClient: createLLMClient("feedbackDraft"),
    draftModel: getLLMModel("feedbackDraft"),
    reviewClient: createLLMClient("feedbackReview"),
    reviewModel: getLLMModel("feedbackReview"),
  });
}

// POST /api/report/feedback - 按课次或时间段生成家校反馈
export async function POST(request: NextRequest) {
  try {
    const { studentId, days, sessionCode } = await request.json();
    if (!studentId) return NextResponse.json({ error: "缺少学生ID" }, { status: 400 });

    if (sessionCode) {
      try {
        const feedbackContext = await buildFeedbackContext(prisma, sessionCode);
        const studentContext = feedbackContext.students.find((student) => student.id === studentId);
        if (!studentContext) return NextResponse.json({ error: "该学生不属于当前课次班级" }, { status: 404 });

        return NextResponse.json(await withLLMCacheOperation(
          "feedback",
          "生成单人课次反馈",
          async () => {
            const result = await reviewedFeedback(
              studentContext.name,
              studentContext.promptContext,
              "90-140字",
              feedbackContext.students.filter((student) => student.id !== studentId).map((student) => student.name),
            );
            if (result.reviewStatus === "needs_review") markCurrentLLMCacheOperationIncomplete();
            return result;
          },
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : "读取反馈上下文失败";
        const status = message.includes("不存在") || message.includes("未关联") || message.includes("无学生") ? 400 : 500;
        return NextResponse.json({ error: message }, { status });
      }
    }

    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: { class: { select: { name: true, code: true } } },
    });
    if (!student) return NextResponse.json({ error: "学生不存在" }, { status: 404 });

    const d = days || 14;
    const since = new Date(); since.setDate(since.getDate() - d);
    const sinceStr = since.toISOString().split("T")[0];

    const [metrics, events, comms, attendances] = await Promise.all([
      prisma.sessionMetric.findMany({ where: { studentId, date: { gte: sinceStr } }, orderBy: { date: "desc" } }),
      prisma.event.findMany({ where: { studentId, session: { date: { gte: sinceStr } } }, orderBy: { createdAt: "desc" }, include: { session: { select: { date: true } } } }),
      prisma.communication.findMany({ where: { studentId, session: { date: { gte: sinceStr } } }, orderBy: { createdAt: "desc" }, include: { session: { select: { date: true } } } }),
      prisma.attendance.findMany({ where: { studentId, session: { date: { gte: sinceStr } } }, include: { session: { select: { date: true } } } }),
    ]);

    const avgA = metrics.length ? (metrics.reduce((sum, metric) => sum + metric.scoreA, 0) / metrics.length).toFixed(1) : "-";
    const avgB = metrics.length ? (metrics.reduce((sum, metric) => sum + metric.scoreB, 0) / metrics.length).toFixed(1) : "-";
    const avgC = metrics.length ? (metrics.reduce((sum, metric) => sum + metric.scoreC, 0) / metrics.length).toFixed(1) : "-";
    const total = attendances.length;
    const present = attendances.filter((attendance) => attendance.present).length;
    const context = `${student.name}（${student.class?.name ?? student.class?.code ?? ""}）近${d}天表现：
- 学习(A): 均分${avgA} | 纪律(B): 均分${avgB} | 作业(C): 均分${avgC}
- 考勤: ${total ? `${present}/${total}` : "无记录"}
- 关键事件: ${events.map((event) => event.description).join("；") || "无"}
- 家校沟通: ${comms.map((communication) => `${communication.session?.date ?? "-"}与${communication.target}:${communication.summary}`).join("；") || "无"}`;

    return NextResponse.json(await withLLMCacheOperation(
      "feedback",
      "生成单人近期反馈",
      async () => {
        const result = await reviewedFeedback(student.name, context, "120-180字");
        if (result.reviewStatus === "needs_review") markCurrentLLMCacheOperationIncomplete();
        return result;
      },
    ));
  } catch (error) {
    console.error("[/api/report/feedback] error:", error);
    return NextResponse.json({ error: "生成反馈失败" }, { status: 500 });
  }
}
