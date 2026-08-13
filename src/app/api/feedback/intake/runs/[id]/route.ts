import { NextRequest, NextResponse } from "next/server";
import { getFeedbackIntakeRun, resolveFeedbackIntakeRun } from "@/services/feedback-intake-service";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const run = await getFeedbackIntakeRun(id);
  if (!run) return NextResponse.json({ error: "反馈材料运行不存在" }, { status: 404 });
  return NextResponse.json({ run });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { action?: unknown; plan?: unknown };
    const action = body.action === "apply" || body.action === "resolve" || body.action === "create_plan" ? body.action : null;
    if (!action) return NextResponse.json({ error: "action 必须是 apply、resolve 或 create_plan" }, { status: 400 });
    const result = await resolveFeedbackIntakeRun(id, { action, plan: body.plan as never });
    return NextResponse.json({ result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "处理反馈材料运行失败" }, { status: 400 });
  }
}
