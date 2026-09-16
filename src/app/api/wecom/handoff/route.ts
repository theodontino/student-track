import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import {
  listWccHandoffPackages,
  scanAndConsumeWccPackages,
} from "@/services/wecom-file-handoff-service";

export async function GET() {
  try {
    return NextResponse.json(await listWccHandoffPackages(prisma));
  } catch (error) {
    const failure = safeApiError(error, "handoff_status_failed");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as { limit?: number };
    return NextResponse.json(await scanAndConsumeWccPackages(prisma, body.limit || 20));
  } catch (error) {
    const failure = safeApiError(error, "handoff_scan_failed");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
