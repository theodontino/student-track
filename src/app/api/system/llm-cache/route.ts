import { NextRequest, NextResponse } from "next/server";
import {
  clearLLMCache,
  getLLMCacheOverview,
  type LLMTaskType,
} from "@/services/llm-cache-service";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { assertProductCapability } from "@/lib/product-capability-guard";
import { hasProductCapability } from "@/lib/product-edition";

export const runtime = "nodejs";

const taskTypes = new Set<LLMTaskType>(["wecom", "classroom-parse", "feedback", "daily-report"]);
const coreTaskTypes = ["classroom-parse", "feedback", "daily-report"] as const satisfies readonly LLMTaskType[];

export async function GET() {
  try {
    const visibleTaskTypes = hasProductCapability("wecomIntegration") ? undefined : coreTaskTypes;
    return NextResponse.json(await getLLMCacheOverview(visibleTaskTypes));
  } catch {
    return NextResponse.json({ error: "读取 LLM 缓存清单失败" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const value = new URL(request.url).searchParams.get("taskType");
  if (value && !taskTypes.has(value as LLMTaskType)) {
    return NextResponse.json({ error: "无效的 LLM 缓存任务类型" }, { status: 400 });
  }
  try {
    if (value === "wecom") assertProductCapability("wecomIntegration");
    const wecomAvailable = hasProductCapability("wecomIntegration");
    if (!value && !wecomAvailable) {
      let removed = 0;
      for (const taskType of coreTaskTypes) {
        removed += (await clearLLMCache(taskType, coreTaskTypes)).removed;
      }
      return NextResponse.json({ removed });
    }
    return NextResponse.json(await clearLLMCache(
      value as LLMTaskType | undefined,
      wecomAvailable ? undefined : coreTaskTypes,
    ));
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(apiErrorBody(error), { status: error.status });
    }
    return NextResponse.json({ error: "清理 LLM 缓存失败" }, { status: 500 });
  }
}
