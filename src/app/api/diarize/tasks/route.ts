import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import {
  createDiarizeTask,
  isDiarizeEngine,
  listDiarizeTasks,
  taskToView,
} from "@/lib/diarize-tasks";
import { runDiarizeTask } from "@/lib/diarize-runner";
import { preflightDiarize } from "@/services/local-tool-status-service";
import { ApiError, apiErrorBody, apiStreamErrorBody, safeApiError } from "@/lib/api-errors";

export const runtime = "nodejs";

function parseSpeakerCount(value: FormDataEntryValue | null) {
  if (value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error("说话人数必须是非负整数");
  return number;
}

function eventLine(event: unknown) {
  return `${JSON.stringify(event)}\n`;
}

export async function GET() {
  const tasks = await listDiarizeTasks();
  const views = await Promise.all(tasks.map((task) => taskToView(task)));
  return NextResponse.json({ tasks: views });
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    const engine = formData.get("engine") || "auto";
    const speakerCount = parseSpeakerCount(formData.get("speakerCount"));

    if (!(audio instanceof File) || audio.size === 0) {
      return NextResponse.json({ error: "请上传音频文件" }, { status: 400 });
    }
    if (!isDiarizeEngine(engine)) {
      return NextResponse.json({ error: "无效的转写引擎" }, { status: 400 });
    }

    const preflight = preflightDiarize(engine);
    if (!preflight.ready) {
      const failure = safeApiError(
        new ApiError(
          `转写环境不可用：${preflight.blockers.join("；")}`,
          503,
          "feature_unavailable",
          false,
        ),
        "转写环境不可用",
      );
      return NextResponse.json({
        ...apiErrorBody(failure),
        preflight,
      }, { status: failure.status });
    }

    let task: Awaited<ReturnType<typeof createDiarizeTask>>;
    try {
      task = await createDiarizeTask({
        title: audio.name,
        engine,
        speakerCount,
        inputFileName: audio.name,
      });
      await fs.promises.writeFile(task.inputPath, Buffer.from(await audio.arrayBuffer()));
    } catch (error: unknown) {
      const failure = safeApiError(error, "创建转写任务失败");
      return NextResponse.json(apiErrorBody(failure), { status: failure.status });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: unknown) => controller.enqueue(encoder.encode(eventLine(event)));
        try {
          emit({ type: "created", task: await taskToView(task) });
          await runDiarizeTask(task, emit);
        } catch (error: unknown) {
          const failure = safeApiError(error, "转写任务失败");
          emit({ type: "error", ...apiStreamErrorBody(failure) });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error && error.message === "说话人数必须是非负整数"
      ? error.message
      : "请求格式无效";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
