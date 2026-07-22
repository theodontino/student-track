import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  acceptWccCandidateBatch,
  type WccCandidateBatch,
} from "@/services/wecomcatch-integration-service";

function authorized(request: NextRequest) {
  const expected = process.env.WECOMCATCH_API_TOKEN || "";
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as WccCandidateBatch;
    return NextResponse.json(await acceptWccCandidateBatch(prisma, body), { status: 202 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "candidate_batch_failed";
    const status = code === "directory_conflict" ? 409 : 400;
    return NextResponse.json({ error: code }, { status });
  }
}
