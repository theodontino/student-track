import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { addFeedbackAttachment, removeFeedbackAttachment } from "@/services/feedback-plan-service";

function errorResponse(error: unknown, fallback: string) {
  const failure = safeApiError(error, fallback);
  return NextResponse.json(apiErrorBody(failure), { status: failure.status });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return errorResponse(new ApiError("请提供附件文件", 400, "invalid_request", false), "保存附件失败");
  const itemId = form.get("itemId");
  try {
    const attachment = await addFeedbackAttachment({
      planId: id,
      planItemId: typeof itemId === "string" && itemId ? itemId : undefined,
      fileName: file.name,
      mimeType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return NextResponse.json({ attachment }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "保存附件失败");
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { attachmentId?: unknown } | null;
  if (typeof body?.attachmentId !== "string" || !body.attachmentId) {
    return errorResponse(new ApiError("附件删除参数无效", 400, "invalid_request", false), "删除附件失败");
  }
  try {
    return NextResponse.json(await removeFeedbackAttachment({ planId: id, attachmentId: body.attachmentId }));
  } catch (error) {
    return errorResponse(error, "删除附件失败");
  }
}
