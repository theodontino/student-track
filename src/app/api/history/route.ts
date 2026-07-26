import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

const MODULES = new Set(["quick-score", "input", "report", "export", "feedback"]);
const HistoryPostSchema = z.object({
  module: z.enum(["quick-score", "input", "report", "export", "feedback"]),
  key: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  state: z.record(z.string(), z.unknown()),
});

function validModule(module: unknown): module is string {
  return typeof module === "string" && MODULES.has(module);
}

function parseState(state: string) {
  try { return JSON.parse(state); }
  catch { return null; }
}

export async function GET(request: NextRequest) {
  const historyModule = new URL(request.url).searchParams.get("module");
  if (!validModule(historyModule)) {
    return NextResponse.json({ error: "无效的历史模块" }, { status: 400 });
  }

  const rows = await prisma.workHistory.findMany({
    where: { module: historyModule },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(rows.flatMap((row) => {
    const state = parseState(row.state);
    return state && typeof state === "object" ? [{ ...row, state }] : [];
  }));
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    const input = HistoryPostSchema.safeParse(body);
    if (!input.success) {
      const error = new ApiError("历史记录参数不完整", 400, "invalid_request", false);
      return NextResponse.json(apiErrorBody(error), { status: error.status });
    }
    const { module: historyModule, key, title, state } = input.data;

    const row = await prisma.workHistory.create({
      data: {
        module: historyModule,
        key: key ?? null,
        title,
        state: JSON.stringify(state),
      },
    });
    return NextResponse.json({ ...row, state: parseState(row.state) }, { status: 201 });
  } catch (error) {
    const safeError = safeApiError(error, "保存历史失败");
    console.error(`[/api/history] POST error (${safeError.diagnosticId ?? "no-diagnostic-id"}):`, error);
    return NextResponse.json(apiErrorBody(safeError), { status: safeError.status });
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const historyModule = searchParams.get("module");

  if (id) {
    await prisma.workHistory.deleteMany({ where: { id } });
    return NextResponse.json({ success: true });
  }
  if (!validModule(historyModule)) {
    return NextResponse.json({ error: "请指定要清理的历史模块" }, { status: 400 });
  }

  const result = await prisma.workHistory.deleteMany({ where: { module: historyModule } });
  return NextResponse.json({ success: true, deleted: result.count });
}
