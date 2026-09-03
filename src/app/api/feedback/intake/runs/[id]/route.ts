import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { getFeedbackIntakeRun, resolveFeedbackIntakeRun, type FeedbackIntakeDecision } from "@/services/feedback-intake-service";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const run = await getFeedbackIntakeRun(id);
    if (!run) return NextResponse.json({ error: "反馈材料运行不存在" }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(apiErrorBody(error), { status: error.status });
    }
    return NextResponse.json({ error: "读取反馈材料运行失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { action?: unknown; plan?: unknown; decisions?: unknown; scope?: unknown };
    const action = body.action === "apply" || body.action === "confirm" || body.action === "resolve" || body.action === "create_plan" || body.action === "confirm_scope" || body.action === "clear_scope" ? body.action : null;
    if (!action) return NextResponse.json({ error: "action 必须是 confirm、confirm_scope、clear_scope、create_plan 或兼容的 apply" }, { status: 400 });
    const decisions = Array.isArray(body.decisions) ? body.decisions as FeedbackIntakeDecision[] : [];
    const scope = body.scope && typeof body.scope === "object"
      ? body.scope as { classId: string; sessionCode: string; studentIds: string[] }
      : undefined;
    const result = await resolveFeedbackIntakeRun(id, { action, decisions, scope, plan: body.plan as never });
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(apiErrorBody(error), { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "处理反馈材料运行失败" }, { status: 400 });
  }
}
