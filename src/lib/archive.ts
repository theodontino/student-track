import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";

/**
 * Archive current SessionMetric values to history before update.
 * Call this BEFORE updating a SessionMetric row.
 */
export async function archiveMetricBeforeUpdate(
  metricId: string,
  changeType: "update" | "delete" = "update",
  db: Prisma.TransactionClient = prisma,
) {
  const current = await db.sessionMetric.findUnique({ where: { id: metricId } });
  if (!current) return;

  await db.sessionMetricHistory.create({
    data: {
      metricId: current.id,
      studentId: current.studentId,
      date: current.date,
      scoreA: current.scoreA,
      scoreB: current.scoreB,
      scoreC: current.scoreC,
      scoreD: current.scoreD,
      operator: current.operator,
      sessionId: current.sessionId,
      changeType,
    },
  });
}
