import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateWeComBridgeJson, type GenerateWeComBridgeInput } from "@/services/wecom-bridge-service";
import { withLLMCacheOperation } from "@/services/llm-cache-service";
import { recordSuccessfulGeneration } from "@/services/generation-memory-service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as GenerateWeComBridgeInput;
    const result = await withLLMCacheOperation(
      "wecom",
      "生成企微候选 JSON",
      () => generateWeComBridgeJson(prisma, body),
    );
    const candidateStudentIds = Array.isArray(body.candidateStudentIds)
      ? body.candidateStudentIds.filter((id): id is string => typeof id === "string")
      : [];
    await recordSuccessfulGeneration({
      taskType: "wecom-bridge", stage: "extraction",
      sourceRefs: candidateStudentIds.map((id) => ({ type: "student" as const, id })),
      promptVersion: "wecom-bridge-v3", modelRole: "wecomExtraction",
      inputSnapshot: { candidateStudentIds, grounded: Array.isArray(body.groundedMessages) },
      // WCC candidate bodies can contain message evidence; the formal ledger keeps only safe diagnostics.
      outputSnapshot: { generatedCandidate: true, diagnostics: result.diagnostics },
    }).catch(() => undefined);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error && /^(缺少|未能从聊天内容)/.test(error.message)
      ? error.message
      : "生成企微候选 JSON 失败，请检查输入和 LLM 配置";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
