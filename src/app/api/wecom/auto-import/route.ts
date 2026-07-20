import { prisma } from "@/lib/prisma";
import { runWeComAutoImport, type WeComAutoImportEvent } from "@/services/wecom-auto-import-service";

export const runtime = "nodejs";
export const maxDuration = 21_600;

export async function POST() {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: WeComAutoImportEvent | { type: "error"; message: string }) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      void runWeComAutoImport(prisma, { emit: send })
        .catch((error: unknown) => {
          const message = error instanceof Error && error.message.startsWith("已有企微一键导入")
            ? error.message
            : "一键导入未完成；数据库未写入失败批次，可稍后重试";
          send({ type: "error", message });
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
