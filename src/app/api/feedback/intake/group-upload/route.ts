import { NextRequest, NextResponse } from "next/server";
import {
  createFeedbackGroupIntake,
  parseFeedbackGroupRunIds,
  type CreateFeedbackGroupIntakeInput,
} from "@/services/feedback-group-intake-service";
import type { IntakeFile } from "@/services/feedback-intake-service";
import { ServiceError } from "@/services/service-error";

export const runtime = "nodejs";

function parseRunIds(value: FormDataEntryValue | null): Record<string, string> | undefined {
  if (value === null || String(value).trim() === "") return undefined;
  return parseFeedbackGroupRunIds(JSON.parse(String(value)) as unknown);
}

function parseDisplayNames(value: FormDataEntryValue | null) {
  if (value === null || String(value).trim() === "") return [] as string[];
  const parsed = JSON.parse(String(value)) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new ServiceError("displayNames 必须是字符串数组", 400);
  }
  return parsed.map((item) => item.trim());
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const groupLessonId = String(formData.get("groupLessonId") || "").trim();
    if (!groupLessonId) return NextResponse.json({ error: "请选择共同课" }, { status: 400 });
    const uploaded = formData.getAll("files").filter((item): item is File => item instanceof File);
    if (!uploaded.length) return NextResponse.json({ error: "请选择文件、文件夹或 ZIP" }, { status: 400 });
    const displayNames = parseDisplayNames(formData.get("displayNames"));
    const files: IntakeFile[] = await Promise.all(uploaded.map(async (file, index) => ({
      name: displayNames[index] || file.name,
      buffer: await file.arrayBuffer(),
      source: "upload" as const,
    })));
    const runIds = parseRunIds(formData.get("runIds"));
    const input: CreateFeedbackGroupIntakeInput = {
      groupLessonId,
      files,
      ...(runIds ? { runIds } : {}),
    };
    return NextResponse.json(await createFeedbackGroupIntake(input));
  } catch (error) {
    if (error instanceof ServiceError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "组投料参数不是有效 JSON" }, { status: 400 });
    console.error("POST /api/feedback/intake/group-upload", error);
    return NextResponse.json({ error: "班级组材料导入失败" }, { status: 500 });
  }
}
