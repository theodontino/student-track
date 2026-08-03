import type { SessionInfo } from "@/lib/types";

export interface QuickScoreRequestContext {
  requestId: number;
  latestRequestId: number;
  requestedSemesterId: string;
  currentSemesterId: string;
  requestedClassId: string;
  currentClassId: string;
  requestedClassName: string;
  currentClassName: string;
}

export function shouldApplyQuickScoreRequest(context: QuickScoreRequestContext): boolean {
  return context.requestId === context.latestRequestId
    && context.requestedSemesterId === context.currentSemesterId
    && context.requestedClassId === context.currentClassId
    && context.requestedClassName === context.currentClassName;
}

export function selectQuickScoreSession(
  sessions: SessionInfo[],
  preferredCode: string,
  today: string,
): SessionInfo | null {
  return (preferredCode ? sessions.find((session) => session.code === preferredCode) : undefined)
    ?? sessions.find((session) => session.date === today)
    ?? sessions[0]
    ?? null;
}
