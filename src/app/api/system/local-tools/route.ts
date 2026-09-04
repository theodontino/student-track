import { NextResponse } from "next/server";
import { ApiError, apiErrorBody } from "@/lib/api-errors";
import { assertProductCapability } from "@/lib/product-capability-guard";
import { getLocalToolsStatus } from "@/services/local-tool-status-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    assertProductCapability("localToolStatus");
    return NextResponse.json(getLocalToolsStatus());
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json(apiErrorBody(error), { status: error.status });
    }
    throw error;
  }
}
