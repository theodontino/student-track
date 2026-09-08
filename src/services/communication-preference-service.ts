import type { PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api-errors";
import {
    CommunicationPreferenceSchema,
    type CommunicationPreference
} from "@/lib/feedback-plan";
import { prisma } from "@/lib/prisma";


function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function json(value: unknown) {
  return JSON.stringify(value);
}

export async function createPreferenceCandidate(input: {
  studentId: string;
  sourceType: "communication" | "teacher";
  sourceId?: string;
  preference: CommunicationPreference;
  evidence?: { source?: "teacher_manual"; signals?: string[] };
}, db: PrismaClient = prisma) {
  const preference = CommunicationPreferenceSchema.parse(input.preference);
  const evidence = {
    ...(input.evidence?.source === "teacher_manual" ? { source: "teacher_manual" as const } : {}),
    ...(input.evidence?.signals?.length ? { signals: input.evidence.signals.filter((signal) => typeof signal === "string").map((signal) => signal.slice(0, 100)).slice(0, 10) } : {}),
  };
  return db.communicationPreferenceCandidate.create({
    data: {
      studentId: input.studentId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      preferenceSnapshot: json(preference),
      evidenceSnapshot: json(evidence),
    },
  });
}

export async function resolvePreferenceCandidate(id: string, decision: "confirmed" | "rejected", db: PrismaClient = prisma) {
  return db.$transaction(async (tx) => {
    const candidate = await tx.communicationPreferenceCandidate.findUnique({ where: { id } });
    if (!candidate) throw new ApiError("沟通偏好候选不存在", 404, "not_found", false);
    if (candidate.status !== "pending") throw new ApiError("沟通偏好候选已经处理，不能重复提交", 409, "conflict", false);
    const updated = await tx.communicationPreferenceCandidate.update({ where: { id }, data: { status: decision, reviewedAt: new Date() } });
    if (decision === "rejected") return updated;
    const preference = CommunicationPreferenceSchema.parse(parseJson(candidate.preferenceSnapshot, {}));
    await tx.communicationPreferenceCandidate.updateMany({
      where: { studentId: candidate.studentId, status: "confirmed", id: { not: id } },
      data: { status: "superseded" },
    });
    await tx.communicationPreference.upsert({
      where: { studentId: candidate.studentId },
      create: { studentId: candidate.studentId, preferenceSnapshot: json(preference), sourceCandidateId: id, confirmedAt: new Date() },
      update: { preferenceSnapshot: json(preference), sourceCandidateId: id, confirmedAt: new Date() },
    });
    return updated;
  });
}
