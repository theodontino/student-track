import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAssistantRosterDraft } from "@/services/assistant-roster-import-service";
import { ApiError, apiErrorBody } from "@/lib/api-errors";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const sessionCode = String(formData.get("sessionCode") || "").trim();
    const uploaded = formData.getAll("files").filter((item): item is File => item instanceof File);

    if (!sessionCode) {
      return NextResponse.json({ error: "请选择课次" }, { status: 400 });
    }
    if (uploaded.length === 0) {
      return NextResponse.json({ error: "请上传助教 Excel 文件" }, { status: 400 });
    }

    const files = await Promise.all(uploaded.map(async (file) => {
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (extension !== "xlsx") throw new Error(`仅支持 .xlsx 文件：${file.name}`);
      return { name: file.name, buffer: await file.arrayBuffer() };
    }));

    return NextResponse.json(await createAssistantRosterDraft(prisma, { sessionCode, files }));
  } catch (error) {
    console.error("[/api/feedback/assistant-roster] error:", error);
    if (error instanceof ApiError) return NextResponse.json(apiErrorBody(error), { status: error.status });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "助教表解析失败" },
      { status: 400 }
    );
  }
}
