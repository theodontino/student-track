import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildWccRosterSnapshot } from "@/services/wecom-roster-directory-service";

function authorized(request: NextRequest) {
  const expected = process.env.WECOMCATCH_API_TOKEN || "";
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const semesterId = request.nextUrl.searchParams.get("semesterId") || "";
  const classId = request.nextUrl.searchParams.get("classId") || "";
  return NextResponse.json(await buildWccRosterSnapshot(prisma, semesterId, classId));
}
