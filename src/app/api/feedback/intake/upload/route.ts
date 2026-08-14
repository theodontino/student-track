import { NextRequest, NextResponse } from "next/server";
import { createOrGetFeedbackIntakeRun, type IntakeFile } from "@/services/feedback-intake-service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const sessionCode = String(formData.get("sessionCode") || "").trim();
    const runIdValue = String(formData.get("runId") || "").trim();
    const uploaded = formData.getAll("files").filter((item): item is File => item instanceof File);
    const displayNames = (() => {
      try {
        const value = JSON.parse(String(formData.get("displayNames") || "[]"));
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      } catch { return []; }
    })();
    if (!sessionCode) return NextResponse.json({ error: "请选择课次" }, { status: 400 });
    if (!uploaded.length) return NextResponse.json({ error: "请选择文件、文件夹或 ZIP" }, { status: 400 });
    const files: IntakeFile[] = await Promise.all(uploaded.map(async (file, index) => ({
      name: displayNames[index] || file.name,
      buffer: await file.arrayBuffer(),
      source: "upload" as const,
    })));
    const result = await createOrGetFeedbackIntakeRun({ sessionCode, files, ...(runIdValue ? { runId: runIdValue } : {}) });
    return NextResponse.json({ ...result, source: "upload" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "导入反馈材料失败" }, { status: 400 });
  }
}
