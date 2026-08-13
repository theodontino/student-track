import { NextRequest, NextResponse } from "next/server";
import { createOrGetFeedbackIntakeRun, resolveFeedbackIntakeRun, type IntakeFile } from "@/services/feedback-intake-service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const sessionCode = String(formData.get("sessionCode") || "").trim();
    const uploaded = formData.getAll("files").filter((item): item is File => item instanceof File);
    if (!sessionCode) return NextResponse.json({ error: "请选择课次" }, { status: 400 });
    if (!uploaded.length) return NextResponse.json({ error: "请选择文件、文件夹或 ZIP" }, { status: 400 });
    const files: IntakeFile[] = await Promise.all(uploaded.map(async (file) => ({
      name: file.name,
      buffer: await file.arrayBuffer(),
      source: "upload" as const,
    })));
    const result = await createOrGetFeedbackIntakeRun({ sessionCode, files });
    const run = await resolveFeedbackIntakeRun(result.run.id, { action: "apply" });
    return NextResponse.json({ ...result, run, source: "upload" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "导入反馈材料失败" }, { status: 400 });
  }
}
