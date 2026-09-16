import { NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { deleteDiarizeTask, readDiarizeTask, taskToView } from "@/lib/diarize-tasks";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const task = await readDiarizeTask(id);
    return NextResponse.json(await taskToView(task, true));
  } catch {
    return NextResponse.json({ error: "转写任务不存在" }, { status: 404 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteDiarizeTask(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const failure = safeApiError(error, "删除转写任务失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
