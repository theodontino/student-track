import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assignWccDraftSession } from "@/services/wecomcatch-integration-service";

function authorized(request: NextRequest) {
  const expected = process.env.WECOMCATCH_API_TOKEN || "";
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { id } = await context.params;
    const body = await request.json() as { sessionCode?: string };
    if (!body.sessionCode) return NextResponse.json({ error: "sessionCode_required" }, { status: 400 });
    const draft = await assignWccDraftSession(prisma, id, body.sessionCode);
    return NextResponse.json({ id: draft.id, sessionCode: draft.sessionCode, status: draft.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "update_failed" }, { status: 400 });
  }
}
