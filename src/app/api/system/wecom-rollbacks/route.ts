import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  ignoreWeComBatchCandidate,
  retryWeComBatchCandidate,
} from "@/services/wecom-import-ledger-service";
import {
  listWeComRollbackOperations,
  rollbackWeComDate,
  rollbackWeComOperation,
  rollbackWeComRun,
} from "@/services/wecom-rollback-service";

export async function GET() {
  try {
    return NextResponse.json(await listWeComRollbackOperations(prisma));
  } catch {
    return NextResponse.json({ error: "读取企微导入记录失败" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      action?: string;
      runId?: string;
      operationId?: string;
      batchId?: string;
      date?: string;
    };
    const result = body.action === "rollback-run"
      ? await rollbackWeComRun(prisma, body.runId || "")
      : body.action === "retry-batch"
        ? await retryWeComBatchCandidate(prisma, body.batchId || "")
        : body.action === "ignore-batch"
          ? await ignoreWeComBatchCandidate(prisma, body.batchId || "")
      : body.action === "rollback-operation"
      ? await rollbackWeComOperation(prisma, body.operationId || "")
      : body.action === "rollback-date"
        ? await rollbackWeComDate(prisma, body.date || "")
        : null;
    if (!result) return NextResponse.json({ error: "不支持的回滚操作" }, { status: 400 });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error && /^(日期|缺少)/.test(error.message)
      ? error.message
      : "企微导入回滚失败，数据库未完成删除";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
