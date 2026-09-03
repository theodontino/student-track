import { NextResponse } from "next/server";
import { purgeExpiredRecycleBin } from "@/services/academic-scope-recycle-service";

export async function POST() {
  try {
    return NextResponse.json(await purgeExpiredRecycleBin());
  } catch (error) {
    console.error("POST /api/recycle-bin/purge-expired", error);
    return NextResponse.json({ error: "回收站到期清理失败，数据已保留，稍后可重试" }, { status: 500 });
  }
}
