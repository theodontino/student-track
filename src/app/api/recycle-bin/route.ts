import { NextResponse } from "next/server";
import { listRecycleBin } from "@/services/academic-scope-recycle-service";

export async function GET() {
  try {
    return NextResponse.json(await listRecycleBin());
  } catch (error) {
    console.error("GET /api/recycle-bin", error);
    return NextResponse.json({ error: "读取回收站失败" }, { status: 500 });
  }
}
