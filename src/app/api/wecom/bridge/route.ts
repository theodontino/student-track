import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateWeComBridgeJson } from "@/services/wecom-bridge-service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { sourceText?: string; exportPath?: string };
    return NextResponse.json(await generateWeComBridgeJson(prisma, body));
  } catch (error: unknown) {
    const message = error instanceof Error && /^(缺少|未能从聊天内容)/.test(error.message)
      ? error.message
      : "生成企微候选 JSON 失败，请检查输入和 LLM 配置";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
