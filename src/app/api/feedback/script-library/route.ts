import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getFeedbackScriptLibrary,
  saveFeedbackScriptLibrary,
} from "@/services/feedback-script-library-service";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { ServiceError } from "@/services/service-error";

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
  if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 400 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const semesterId = request.nextUrl.searchParams.get("semesterId")?.trim() || "";
    const sessionCode = request.nextUrl.searchParams.get("sessionCode")?.trim() || undefined;
    if (!semesterId) return NextResponse.json({ error: "请选择学期" }, { status: 400 });
    return NextResponse.json(await getFeedbackScriptLibrary(prisma, semesterId, sessionCode));
  } catch (error) {
    console.error("[/api/feedback/script-library] get error:", error);
    return errorResponse(error, "获取话术库失败");
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const semesterId = String(formData.get("semesterId") || "").trim();
    const sessionCode = String(formData.get("sessionCode") || "").trim() || undefined;
    const replaceExisting = formData.get("replaceExisting") === "true";
    const file = formData.get("file");
    if (!semesterId) return NextResponse.json({ error: "请选择学期" }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "请选择话术库 Excel" }, { status: 400 });
    if (file.name.split(".").pop()?.toLowerCase() !== "xlsx") {
      return NextResponse.json({ error: "仅支持 .xlsx 文件" }, { status: 400 });
    }
    return NextResponse.json(await saveFeedbackScriptLibrary(
      prisma,
      semesterId,
      await file.arrayBuffer(),
      sessionCode,
      replaceExisting,
    ));
  } catch (error) {
    console.error("[/api/feedback/script-library] save error:", error);
    return errorResponse(error, "导入话术库失败");
  }
}
