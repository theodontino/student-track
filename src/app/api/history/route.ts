import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const MODULES = new Set(["quick-score", "input", "report", "export", "feedback"]);

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
    const { module: historyModule, key, title, state } = await request.json();
    if (!validModule(historyModule) || typeof title !== "string" || !title.trim() || !state || typeof state !== "object") {
      return NextResponse.json({ error: "历史记录参数不完整" }, { status: 400 });
    }

    const row = await prisma.workHistory.create({
      data: {
        module: historyModule,
        key: typeof key === "string" && key ? key : null,
        title: title.trim(),
        state: JSON.stringify(state),
      },
    });
    return NextResponse.json({ ...row, state: parseState(row.state) }, { status: 201 });
  } catch (error) {
    console.error("[/api/history] POST error:", error);
    return NextResponse.json({ error: "保存历史失败" }, { status: 500 });
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
