"use client";

import { useEffect, useMemo, useState } from "react";
import { useTeachingContext, teachingContextWorkspaceKey } from "@/features/teaching-context";
import { requestJson } from "@/lib/api-client";
import { saveWorkHistory } from "@/lib/history";
import type { DraftParseResult } from "@/lib/types";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import { isInputWorkspaceState, type InputWorkspaceState } from "./workspace-state";

export interface InputHistoryState {
  rawText: string;
  semesterId: string;
  className: string;
  sessionCode: string;
  result: DraftParseResult;
}

export function useInputWorkspace() {
  const [rawText, setRawText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DraftParseResult | null>(null);
  const [error, setError] = useState("");
  const { context, hydrated: contextHydrated, setContext, setSemesterId, setClassName, setSessionCode } = useTeachingContext();
  const workspaceValue = useMemo<InputWorkspaceState>(() => ({ context, rawText, result }), [context, rawText, result]);
  const workspace = useSessionWorkspace({
    key: teachingContextWorkspaceKey("entry-input", context),
    value: workspaceValue,
    validate: isInputWorkspaceState,
    enabled: contextHydrated,
    restore: (saved) => {
      setRawText(saved?.rawText ?? "");
      setResult(saved?.result ?? null);
      setError("");
    },
  });

  useEffect(() => {
    if (!workspace.hydrated) return;
    const draft = sessionStorage.getItem("chem-track:nl-input-draft");
    if (!draft) return;
    setRawText(draft);
    sessionStorage.removeItem("chem-track:nl-input-draft");
  }, [workspace.hydrated]);

  async function submit() {
    if (!rawText.trim() || !context.sessionCode) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const data = await requestJson<DraftParseResult>("/api/input/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText, sessionCode: context.sessionCode }),
      });
      setResult(data);
      try {
        await saveWorkHistory("input", `${context.className} ${context.sessionCode} NL录入`, {
          rawText,
          semesterId: context.semesterId,
          className: context.className,
          sessionCode: context.sessionCode,
          result: data,
        }, context.sessionCode);
      } catch (historyError) {
        console.error("save input history failed:", historyError);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "解析失败");
    } finally {
      setLoading(false);
    }
  }

  function restoreHistory(state: InputHistoryState) {
    setRawText(state.rawText);
    setContext({ semesterId: state.semesterId, className: state.className, sessionCode: state.sessionCode });
    setResult(state.result);
    setError("");
  }

  return {
    context,
    contextHydrated,
    rawText,
    setRawText,
    loading,
    result,
    error,
    submit,
    restoreHistory,
    setSemesterId,
    setClassName,
    setSessionCode,
  };
}
