import { NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { createDatabaseBackup } from "@/services/database-backup-service";

export async function POST() {
  try {
    const result = await createDatabaseBackup();
    return NextResponse.json({
      success: true,
      fileName: result.manifest.databaseFile,
      sizeBytes: result.manifest.sizeBytes,
      sha256: result.manifest.sha256,
      rowCounts: result.manifest.verification.rowCounts,
    });
  } catch (error) {
    console.error("[/api/system/archive] error:", error);
    const failure = safeApiError(error, "数据库备份失败");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
