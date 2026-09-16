import { prisma } from "@/lib/prisma";
import { ApiError, apiErrorBody, safeApiError } from "@/lib/api-errors";
import { buildAssistantRosterTemplate } from "@/services/assistant-roster-template-service";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const workbook = await buildAssistantRosterTemplate(prisma, id);
    const safeCode = id.replace(/[^A-Za-z0-9._-]/g, "-");
    return new Response(workbook, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="assistant-roster-${safeCode}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      const failure = safeApiError(error, "生成助教评分表失败");
      return Response.json(apiErrorBody(failure), { status: failure.status });
    }
    console.error("[/api/sessions/[id]/assistant-roster-template] error:", error);
    const failure = safeApiError(error, "生成助教评分表失败");
    return Response.json(apiErrorBody(failure), { status: failure.status });
  }
}
