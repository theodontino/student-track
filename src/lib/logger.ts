import { prisma } from "@/lib/prisma";

export type LogAction =
  | "score.updated"
  | "alert.triggered"
  | "student.deleted"
  | "student.enrollment.transferred"
  | "student.roster-status.updated"
  | "session.created"
  | "session.deleted"
  | "data.exported";

export type LogTargetType = "Student" | "Session" | "Draft" | "Class" | "System";

interface LogEntry {
  action: LogAction;
  targetType: LogTargetType;
  targetId?: string;
  targetName?: string;
  detail?: Record<string, unknown>;
}

/**
 * Write a system log entry. Fire-and-forget: errors are caught and logged,
 * never propagated — log failure must not break the main operation.
 */
export async function logAction(entry: LogEntry): Promise<void> {
  try {
    await prisma.systemLog.create({
      data: {
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        targetName: entry.targetName ?? null,
        detail: JSON.stringify(entry.detail ?? {}),
      },
    });
  } catch (err) {
    console.error("[SystemLog] Failed to write log:", err);
  }
}

export async function logStudentEnrollmentTransfer(input: {
  studentId: string;
  studentName?: string;
  semesterId: string;
  previousClass: { id: string; code: string; name: string | null };
  currentClass: { id: string; code: string; name: string | null };
}): Promise<void> {
  await logAction({
    action: "student.enrollment.transferred",
    targetType: "Student",
    targetId: input.studentId,
    targetName: input.studentName,
    detail: {
      semesterId: input.semesterId,
      fromClass: input.previousClass,
      toClass: input.currentClass,
    },
  });
}
