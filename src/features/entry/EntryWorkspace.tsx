"use client";

import { useEffect, useReducer } from "react";
import { PageHeader, Tabs } from "@/components/ui";
import InputStep from "./InputStep";
import ReviewStep from "./ReviewStep";
import { entryReducer, type EntryStep } from "./entry-reducer";

export default function EntryWorkspace() {
  const [state, dispatch] = useReducer(entryReducer, { step: "input" });
  useEffect(() => { const step = new URLSearchParams(window.location.search).get("step"); if (step === "review") dispatch({ type: "set-step", step }); }, []);
  function setStep(step: EntryStep) { const url = new URL(window.location.href); url.searchParams.set("step", step); window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`); dispatch({ type: "set-step", step }); }
  return <div className="mx-auto max-w-5xl"><PageHeader title="课堂录入" description="输入课堂记录、解析草案并复核确认，步骤间上下文保持连续。" /><Tabs label="录入步骤" value={state.step} onChange={(value) => setStep(value as EntryStep)} items={[{ value: "input", label: "1 输入与解析" }, { value: "review", label: "2 复核与确认" }]} /><div className="mt-6">{state.step === "input" ? <InputStep onReview={() => setStep("review")} /> : <ReviewStep />}</div></div>;
}
