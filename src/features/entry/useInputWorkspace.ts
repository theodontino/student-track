"use client";

import { useEffect, useMemo, useState } from "react";
import { useTeachingContext, teachingContextWorkspaceKey } from "@/features/teaching-context";
import { useAiWorkflow } from "@/features/ai-workflow";
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
  const workflow = useAiWorkflow();
  const { context, hydrated: contextHydrated, setContext, setSemesterId, setClassName, setSessionCode } = useTeachingContext();
  const workspaceValue = useMemo<InputWorkspaceState>(() => ({ context, rawText, result, workflow: workflow.state }), [context, rawText, result, workflow.state]);
  const workspace = useSessionWorkspace({
    key: teachingContextWorkspaceKey("entry-input", context),
    value: workspaceValue,
    validate: isInputWorkspaceState,
    enabled: contextHydrated,
    restore: (saved) => {
      setRawText(saved?.rawText ?? "");
      setResult(saved?.result ?? null);
      workflow.restore(saved?.workflow);
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
    workflow.start("解析课堂记录", "正在核对课次和输入内容…");
    workflow.transition("generating", "AI 正在把课堂记录整理成结构化草案…");
    try {
      const data = await requestJson<DraftParseResult>("/api/input/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText, sessionCode: context.sessionCode }),
      });
      setResult(data);
      workflow.transition("reviewing", "草案已生成，请人工核对后再写入学生档案。");
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
      const message = reason instanceof Error ? reason.message : "解析失败";
      setError(message);
      workflow.fail(message, "generating");
    } finally {
      setLoading(false);
    }
  }

  function restoreHistory(state: InputHistoryState) {
    setRawText(state.rawText);
    setContext({ semesterId: state.semesterId, className: state.className, sessionCode: state.sessionCode });
    setResult(state.result);
    workflow.reset();
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
    workflow: workflow.state,
    submit,
    restoreHistory,
    setSemesterId,
    setClassName,
    setSessionCode,
  };
}
