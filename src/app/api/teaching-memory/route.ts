import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorBody, ApiError, safeApiError } from "@/lib/api-errors";
import {
  compactHotGenerationRecordsForClass,
  confirmLongTermMemory,
  generateLongTermMemoryDraftsForClass,
  getConfirmedTeachingMemory,
  listGenerationHistory,
  undoHotToWarmCompaction,
} from "@/services/generation-memory-service";
import { prisma } from "@/lib/prisma";

const QuerySchema = z.object({
  studentId: z.string().trim().min(1).optional(),
  classId: z.string().trim().min(1).optional(),
  semesterId: z.string().trim().min(1).optional(),
  operations: z.literal("1").optional(),
});

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("compact"), classId: z.string().trim().min(1) }),
  z.object({ action: z.literal("long-term-drafts"), classId: z.string().trim().min(1) }),
  z.object({ action: z.literal("undo"), runId: z.string().trim().min(1) }),
]);

const ConfirmSchema = z.object({ id: z.string().trim().min(1), content: z.string().trim().min(1).max(800) });

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      studentId: url.searchParams.get("studentId") || undefined,
      classId: url.searchParams.get("classId") || undefined,
      semesterId: url.searchParams.get("semesterId") || undefined,
      operations: url.searchParams.get("operations") || undefined,
    });
    if (!parsed.success) return NextResponse.json({ error: "查询参数不完整" }, { status: 400 });
    const scopeWhere = parsed.data.studentId
      ? { scopeType: "student", scopeId: parsed.data.studentId }
      : parsed.data.classId
        ? { scopeType: "class", scopeId: parsed.data.classId }
        : {};
    const [memories, history, drafts, classes, undoableRuns] = await Promise.all([
      getConfirmedTeachingMemory(parsed.data, prisma),
      listGenerationHistory(parsed.data, prisma),
      prisma.teachingMemory.findMany({ where: { ...scopeWhere, memoryTier: "long-term", status: "draft" }, orderBy: { generatedAt: "desc" }, take: 100 }),
      parsed.data.operations
        ? prisma.class.findMany({ orderBy: [{ name: "asc" }, { code: "asc" }], select: { id: true, name: true, code: true } })
        : Promise.resolve([]),
      parsed.data.operations ? prisma.memoryCompactionRun.findMany({
        where: {
          phase: "hot-to-warm",
          status: "succeeded",
          rollbackPayload: { not: null },
          undoUntil: { gte: new Date() },
        },
        orderBy: { completedAt: "desc" },
        take: 100,
      }) : Promise.resolve([]),
    ]);
    const studentIds = drafts.filter((item) => item.scopeType === "student").map((item) => item.scopeId);
    const students = await prisma.student.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true } });
    const names = new Map([
      ...students.map((item) => [item.id, item.name] as const),
      ...classes.map((item) => [item.id, item.name ?? item.code] as const),
    ]);
    return NextResponse.json({
      memories,
      history,
      classes,
      drafts: drafts.map((item) => ({ ...item, scopeName: names.get(item.scopeId) ?? "已删除对象" })),
      undoableRuns: undoableRuns.map((run) => ({ ...run, className: names.get(run.classId) ?? "已删除班级" })),
    });
  } catch (error) {
    const safe = safeApiError(error, "读取教学记忆失败");
    return NextResponse.json(apiErrorBody(safe), { status: safe.status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ApiError("教学记忆操作参数无效", 400, "invalid_request", false);
    if (parsed.data.action === "compact") return NextResponse.json(await compactHotGenerationRecordsForClass(parsed.data.classId, prisma));
    if (parsed.data.action === "long-term-drafts") return NextResponse.json(await generateLongTermMemoryDraftsForClass(parsed.data.classId, prisma));
    await undoHotToWarmCompaction(parsed.data.runId, prisma);
    return NextResponse.json({ success: true });
  } catch (error) {
    const safe = safeApiError(error, "教学记忆处理失败");
    return NextResponse.json(apiErrorBody(safe), { status: safe.status });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const parsed = ConfirmSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ApiError("长期背景参数无效", 400, "invalid_request", false);
    const memory = await confirmLongTermMemory(parsed.data.id, parsed.data.content, prisma);
    return NextResponse.json(memory);
  } catch (error) {
    const safe = safeApiError(error, "确认长期背景失败");
    return NextResponse.json(apiErrorBody(safe), { status: safe.status });
  }
}
