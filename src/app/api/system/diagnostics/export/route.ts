import { NextResponse } from "next/server";
import { createDiagnosticsExport } from "@/lib/diagnostics";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";

export const runtime = "nodejs";

function downloadFilename(exportedAt: string) {
  return `student-track-diagnostics-${exportedAt.replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "")}.json`;
}

export async function GET() {
  try {
    const payload = await createDiagnosticsExport();
    return NextResponse.json(payload, {
      headers: {
        "Content-Disposition": `attachment; filename="${downloadFilename(payload.exportedAt)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const failure = safeApiError(error, "生成诊断包失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
