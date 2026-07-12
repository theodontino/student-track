"use client";

import { useCallback, useEffect, useState } from "react";
import type { TeachingContext } from "./types";
import { applyTeachingContext, emptyTeachingContext, parseTeachingContext } from "./url-context";

function readContext(): TeachingContext {
  if (typeof window === "undefined") return emptyTeachingContext;
  return parseTeachingContext(window.location.search);
}
function writeContext(context: TeachingContext) {
  const url = applyTeachingContext(new URL(window.location.href), context);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
export function useTeachingContext(initial: Partial<TeachingContext> = {}) {
  const [context, setContextState] = useState<TeachingContext>({ ...emptyTeachingContext, ...initial });
  useEffect(() => setContextState((current) => ({ ...current, ...readContext() })), []);
  const setContext = useCallback((next: TeachingContext | ((current: TeachingContext) => TeachingContext)) => setContextState((current) => { const value = typeof next === "function" ? next(current) : next; writeContext(value); return value; }), []);
  return {
    context,
    setContext,
    setSemesterId: useCallback((semesterId: string) => setContext({ semesterId, className: "", sessionCode: "" }), [setContext]),
    setClassName: useCallback((className: string) => setContext((current) => ({ ...current, className, sessionCode: "" })), [setContext]),
    setSessionCode: useCallback((sessionCode: string) => setContext((current) => ({ ...current, sessionCode })), [setContext]),
  };
}
