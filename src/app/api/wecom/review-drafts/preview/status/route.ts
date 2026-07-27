import { NextRequest, NextResponse } from "next/server";
import {
  cancelPreReviewTask,
  getPreReviewTask,
  listPreReviewTasks,
} from "@/services/wecom-prereview-service";

export async function GET(request: NextRequest) {
  const taskId = request.nextUrl.searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ tasks: listPreReviewTasks() });
  }
  const task = getPreReviewTask(taskId);
  if (!task) return NextResponse.json({ error: "task_not_found" }, { status: 404 });
  return NextResponse.json(task);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { taskId?: unknown; action?: unknown };
    if (typeof body.taskId !== "string") {
      return NextResponse.json({ error: "taskId 必填" }, { status: 400 });
    }
    if (body.action === "cancel") {
      const ok = cancelPreReviewTask(body.taskId);
      return NextResponse.json({ cancelled: ok });
    }
    return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "preview_control_failed" }, { status: 400 });
  }
}
