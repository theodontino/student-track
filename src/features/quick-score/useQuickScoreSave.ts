"use client";

import { useState } from "react";
import type { CardScore, SessionInfo } from "@/lib/types";
import { saveQuickScores } from "./api";
import type { QuickScoreNotice, QuickScoreSaveResult } from "./types";
import { quickScorePayload, type OriginalScore } from "./score-changes";

export function useQuickScoreSave({
  changedCards,
  originalScores,
  ready,
  date,
  sessionCode,
  sessions,
  setNotice,
  setResult,
  reloadSession,
}: {
  changedCards: CardScore[];
  originalScores: Map<string, OriginalScore>;
  ready: boolean;
  date: string;
  sessionCode: string;
  sessions: SessionInfo[];
  setNotice: (notice: QuickScoreNotice | null) => void;
  setResult: (result: QuickScoreSaveResult | null) => void;
  reloadSession: (session: SessionInfo) => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!ready || submitting) return;
    if (changedCards.length === 0) {
      setNotice({ tone: "info", message: "没有改动，无需提交。" });
      return;
    }
    const payload = quickScorePayload(changedCards, originalScores, date, sessionCode);
    setSubmitting(true);
    setNotice(null);
    try {
      const data = await saveQuickScores(payload);
      setResult(data);
      if (sessionCode) {
        const session = sessions.find((item) => item.code === sessionCode);
        if (session) await reloadSession(session);
      }
    } catch (error) {
      setNotice({ tone: "danger", message: error instanceof Error ? error.message : "提交失败" });
    } finally {
      setSubmitting(false);
    }
  }

  return { submitting, submit };
}
