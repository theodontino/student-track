"use client";

import { useState } from "react";
import { saveWorkHistory } from "@/lib/history";
import type { CardScore, SessionInfo } from "@/lib/types";
import { saveQuickScores } from "./api";
import type { QuickScoreNotice, QuickScoreSaveResult } from "./types";

export function useQuickScoreSave({
  cards,
  changedCards,
  date,
  semesterId,
  classId,
  className,
  sessionCode,
  sessions,
  setNotice,
  setResult,
  reloadSession,
}: {
  cards: CardScore[];
  changedCards: CardScore[];
  date: string;
  semesterId: string;
  classId: string;
  className: string;
  sessionCode: string;
  sessions: SessionInfo[];
  setNotice: (notice: QuickScoreNotice | null) => void;
  setResult: (result: QuickScoreSaveResult | null) => void;
  reloadSession: (session: SessionInfo) => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (changedCards.length === 0) {
      setNotice({ tone: "info", message: "没有改动，无需提交。" });
      return;
    }
    const scores = changedCards.map((card) => ({
      studentId: card.studentId,
      date,
      scoreA: card.scoreA,
      scoreB: card.scoreB,
      scoreC: card.scoreC,
      note: card.note || undefined,
    }));
    const attendances = changedCards.map((card) => ({ studentId: card.studentId, present: card.present }));
    setSubmitting(true);
    setNotice(null);
    try {
      const data = await saveQuickScores({ scores, sessionCode: sessionCode || undefined, attendances });
      setResult(data);
      try {
        await saveWorkHistory("quick-score", `${className} ${sessionCode || date} 手动评分`, {
          semesterId,
          classId,
          className,
          sessionCode,
          date,
          cards,
        }, sessionCode || date);
      } catch (historyError) {
        console.error("save quick-score history failed:", historyError);
      }
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
