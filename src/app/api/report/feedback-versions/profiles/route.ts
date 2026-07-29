import { NextResponse } from "next/server";
import { getSafeLLMProfileSummaries } from "@/lib/llm-settings";

export async function GET() {
  return NextResponse.json({ profiles: getSafeLLMProfileSummaries() });
}
