import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import { prisma } from "@/lib/prisma";
import {
    assertFeedbackPlanAvailable
} from "@/services/academic-scope-recycle-service";
import { createHash } from "node:crypto";


import { discardFeedbackAttachment, readFeedbackAttachment, withFeedbackAttachmentRemoval, writeFeedbackAttachment } from "@/services/feedback-attachment-storage";
type FeedbackPlanDb = PrismaClient | Prisma.TransactionClient;
export async function validateFeedbackPlanAttachments(planId: string, db: FeedbackPlanDb = prisma) {
  const attachments = await db.feedbackAttachment.findMany({ where: { planId } });
  const result: Array<{ id: string; status: "available" | "missing" }> = [];
  for (const attachment of attachments) {
    let status: "available" | "missing" = "available";
    try {
      const bytes = await readFeedbackAttachment(planId, attachment.relativeLocator);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== attachment.sizeBytes || hash !== attachment.sha256) status = "missing";
    } catch {
      status = "missing";
    }
    if (attachment.status !== status) await db.feedbackAttachment.update({ where: { id: attachment.id }, data: { status } });
    result.push({ id: attachment.id, status });
  }
  return result;
}

export async function addFeedbackAttachment(input: {
  planId: string;
  planItemId?: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}, db: PrismaClient = prisma) {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > 25 * 1024 * 1024) throw new ApiError("附件大小必须在 1B 到 25MB 之间", 400, "invalid_request", false);
  await assertFeedbackPlanAvailable(input.planId, db);
  const plan = await db.feedbackPlan.findUnique({ where: { id: input.planId }, select: { id: true, archivedAt: true } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  if (input.planItemId) {
    const item = await db.feedbackPlanItem.findFirst({ where: { id: input.planItemId, planId: input.planId }, select: { id: true } });
    if (!item) throw new ApiError("反馈计划条目不存在", 404, "not_found", false);
  }
  const { hash, relativeLocator } = await writeFeedbackAttachment(input.planId, input.fileName, input.bytes);
  try {
    return await db.feedbackAttachment.create({
      data: {
        planId: input.planId,
        planItemId: input.planItemId,
        displayName: input.fileName.trim().slice(0, 200) || "attachment",
        mimeType: input.mimeType.trim().slice(0, 200) || "application/octet-stream",
        sizeBytes: input.bytes.byteLength,
        sha256: hash,
        relativeLocator,
      },
    });
  } catch (error) {
    await discardFeedbackAttachment(input.planId, relativeLocator);
    throw error;
  }
}

export async function removeFeedbackAttachment(input: { planId: string; attachmentId: string }, db: PrismaClient = prisma) {
  await assertFeedbackPlanAvailable(input.planId, db);
  const plan = await db.feedbackPlan.findUnique({ where: { id: input.planId }, select: { id: true, archivedAt: true } });
  if (!plan) throw new ApiError("反馈计划不存在", 404, "not_found", false);
  if (plan.archivedAt) throw new ApiError("已归档反馈计划为只读，请先取消归档", 409, "conflict", false);
  const attachment = await db.feedbackAttachment.findFirst({ where: { id: input.attachmentId, planId: input.planId } });
  if (!attachment) throw new ApiError("反馈附件不存在", 404, "not_found", false);
  return withFeedbackAttachmentRemoval(input.planId, attachment.relativeLocator, async () => {
    await db.feedbackAttachment.delete({ where: { id: attachment.id } });
    return { id: attachment.id, deleted: true };
  });
}
