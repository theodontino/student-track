import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";

// GET /api/system/logs — query log entries with optional filters
// ?action=score.updated&targetType=Student&targetName=张三&limit=50&offset=0
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || undefined;
    const targetType = url.searchParams.get("targetType") || undefined;
    const targetName = url.searchParams.get("targetName") || undefined;
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const where: Record<string, unknown> = {};
    if (action) where.action = action;
    if (targetType) where.targetType = targetType;
    if (targetName) where.targetName = { contains: targetName };

    const [logs, total] = await Promise.all([
      prisma.systemLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.systemLog.count({ where }),
    ]);

    return NextResponse.json({
      logs: logs.map((l) => ({
        ...l,
        detail: JSON.parse(l.detail),
      })),
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    console.error("[/api/system/logs] error:", error);
    const failure = safeApiError(error, "获取日志失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
