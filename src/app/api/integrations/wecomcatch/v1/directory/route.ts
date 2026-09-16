import { NextRequest, NextResponse } from "next/server";
import { apiErrorBody, safeApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import { buildWccRosterSnapshot } from "@/services/wecom-roster-directory-service";
import { ServiceError } from "@/services/service-error";

function authorized(request: NextRequest) {
  const expected = process.env.WECOMCATCH_API_TOKEN || "";
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const semesterId = request.nextUrl.searchParams.get("semesterId") || "";
  const classId = request.nextUrl.searchParams.get("classId") || "";
  try {
    return NextResponse.json(await buildWccRosterSnapshot(prisma, semesterId, classId));
  } catch (error) {
    if (error instanceof ServiceError && error.status < 500) return NextResponse.json({ error: error.message }, { status: error.status });
    const failure = safeApiError(error, "directory_failed");
    return NextResponse.json(apiErrorBody(failure), { status: failure.status });
  }
}
