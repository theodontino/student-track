import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  acceptWccCandidateBatch,
  type WccCandidateBatch,
} from "@/services/wecomcatch-integration-service";
import {
  WeComExtractionError,
} from "@/services/wecom-bridge-service";

type IntegrationErrorCode =
  | "auth_failed"
  | "directory_conflict"
  | "invalid_batch"
  | "evidence_mismatch"
  | "model_not_found"
  | "model_output_invalid"
  | "service_unavailable"
  | "internal_error";

function errorResponse(
  code: IntegrationErrorCode,
  scope: "system" | "item",
  retryable: boolean,
  message: string,
  status: number,
) {
  return NextResponse.json({
    error: { code, scope, retryable, message },
  }, { status });
}

function integrationFailure(error: unknown) {
  if (error instanceof WeComExtractionError) {
    if (error.code === "evidence_mismatch") {
      return errorResponse("evidence_mismatch", "item", false, "原文证据与消息内容不一致", 422);
    }
    if (["schema_invalid", "output_truncated", "oversized_message"].includes(error.code)) {
      return errorResponse("model_output_invalid", "item", false, "模型输出未通过候选校验", 422);
    }
    if (error.code === "model_not_found") {
      return errorResponse("model_not_found", "system", false, "配置的模型不存在或不可用", 503);
    }
    return errorResponse(
      "service_unavailable",
      "system",
      ["network_error", "provider_error"].includes(error.code),
      "模型服务暂时不可用",
      503,
    );
  }
  const code = error instanceof Error ? error.message : "";
  if (code === "directory_conflict") {
    return errorResponse("directory_conflict", "item", false, "学生身份需要重新对齐", 409);
  }
  if ([
    "unsupported_contract",
    "invalid_batch",
    "duplicate_message_ids",
    "missing_subjects",
  ].includes(code) || error instanceof SyntaxError) {
    return errorResponse("invalid_batch", "item", false, "候选批次未通过校验", 400);
  }
  return errorResponse("internal_error", "system", false, "候选入库发生内部错误", 500);
}

function authorized(request: NextRequest) {
  const expected = process.env.WECOMCATCH_API_TOKEN || "";
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return errorResponse("auth_failed", "system", false, "集成凭据无效", 401);
  }
  try {
    const body = await request.json() as WccCandidateBatch;
    return NextResponse.json(await acceptWccCandidateBatch(prisma, body), { status: 202 });
  } catch (error) {
    return integrationFailure(error);
  }
}
