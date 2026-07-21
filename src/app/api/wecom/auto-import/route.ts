import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getWeComAutoImportStatus,
  requestWeComAutoImportCancellation,
  runWeComAutoImport,
  type WeComAutoImportEvent,
  type WeComCancelMode,
} from "@/services/wecom-auto-import-service";
import {
  markCurrentLLMCacheOperationIncomplete,
  withLLMCacheOperation,
} from "@/services/llm-cache-service";

export const runtime = "nodejs";
export const maxDuration = 21_600;

type ImportPhase = Extract<WeComAutoImportEvent, { type: "progress" }>['phase'];

function safeImportErrorReason(message: string, phase: ImportPhase) {
  if (message.includes("LLM API Key 未设置")) {
    return "LLM API Key 未设置，请先到“LLM 配置”保存并启用一个配置";
  }
  if (message.includes("full sidebar scan incomplete")) {
    return "WeComCatch 本轮会话扫描覆盖率低于安全门槛；请保持企微窗口打开并停止操作后重试";
  }
  if (message.includes("window size changed") || message.includes("sidebar width changed")) {
    return "扫描期间企微窗口或会话侧栏尺寸发生变化；请保持窗口不动后重试";
  }
  if (message.includes("Visible conversation table not found")) {
    return "没有找到企微会话列表；请打开企微主窗口并停留在消息页后重试";
  }
  if (message.includes("conversation scrollbar not found") || message.includes("conversation scrollbar failed")) {
    return "无法控制企微会话侧栏；请确认 Mac 已解锁、企微窗口可见且辅助功能权限仍然有效";
  }
  if (message.includes("Accessibility") || message.includes("not authorized")) {
    return "WeComCatch 没有可用的辅助功能权限；请在 macOS 系统设置中重新授权后重试";
  }
  if (message.includes("WeComCatch 环境不可用")) {
    return "WeComCatch 环境检查未通过；请展开本地工具检查详情并处理不可用项目";
  }
  if (message.includes("同步需要人工处理")) {
    return "WeComCatch 检测到未完成或失败任务；请先在手动同步区读取状态，处理后再重试";
  }
  if (message.includes("同步超时")) {
    return "WeComCatch 同步等待超时；任务可能仍在运行，请先在手动同步区查看进度";
  }
  if (message.includes("不支持 JSON Schema") || message.includes("结构化输出")) {
    return "企微提取模型协议不兼容：不支持 JSON Schema 或 JSON Object；请在 LLM 配置中更换企微提取模型后重试";
  }
  if (message.includes("长度上限") || message.includes("输出被截断")) {
    return "企微提取输出被截断；系统已尝试二分交流段，不能再拆的单条消息已暂停待人工处理";
  }
  if (message.includes("Schema")) {
    return "企微提取结果未通过 Schema 校验；该交流段未写入数据库，并已记录失败次数";
  }
  if (message.includes("网络请求")) {
    return "企微提取网络请求重试后仍失败；该交流段未写入数据库";
  }
  if (phase === "syncing") {
    return "WeComCatch 启动或执行同步失败；请保持企微窗口打开，并在手动同步区读取状态";
  }
  if (phase === "exporting") {
    return "WeComCatch 导出失败；已归档聊天不会丢失，请在手动同步区重新导出";
  }
  if (phase === "extracting") {
    return "LLM 调用或候选提取失败；请检查当前 LLM 配置和网络后重试";
  }
  if (phase === "importing") {
    return "候选校验或数据库写入失败；失败批次未提交，可安全重试";
  }
  return "一键导入预检查未通过；请检查 WeComCatch 与 LLM 配置后重试";
}

function safeImportError(error: unknown, phase: ImportPhase) {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("已有企微一键导入")) return message;
  return `${safeImportErrorReason(message, phase)}；数据库未写入失败批次，可安全重试`;
}

export async function GET() {
  try {
    return NextResponse.json(await getWeComAutoImportStatus(prisma));
  } catch {
    return NextResponse.json({ error: "读取企微导入状态失败" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { mode?: WeComCancelMode };
    const mode: WeComCancelMode = body.mode === "stop_and_rollback" ? "stop_and_rollback" : "stop";
    return NextResponse.json(await requestWeComAutoImportCancellation(prisma, mode), { status: 202 });
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("当前没有")
      ? error.message
      : "停止企微导入失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let phase: ImportPhase = "preflight";
      const send = (event: WeComAutoImportEvent | { type: "error"; message: string }) => {
        if (event.type === "progress") phase = event.phase;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      void withLLMCacheOperation(
        "wecom",
        "企微一键同步并导入",
        async () => {
          const result = await runWeComAutoImport(prisma, { emit: send });
          if (result && (result.type === "cancelled" || result.attentionBatchCount > 0)) {
            markCurrentLLMCacheOperationIncomplete();
          }
          return result;
        },
      )
        .catch((error: unknown) => {
          send({ type: "error", message: safeImportError(error, phase) });
        })
        .finally(() => controller.close());
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
