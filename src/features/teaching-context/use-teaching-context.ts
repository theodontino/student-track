"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TeachingContext } from "./types";
import {
  applyTeachingContext,
  emptyTeachingContext,
  hasTeachingContext,
  parseTeachingContext,
  readStoredTeachingContext,
  writeStoredTeachingContext,
} from "./url-context";

function readContext(): TeachingContext {
  if (typeof window === "undefined") return emptyTeachingContext;
  return parseTeachingContext(window.location.search);
}
function writeContext(context: TeachingContext) {
  const url = applyTeachingContext(new URL(window.location.href), context);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  writeStoredTeachingContext(window.sessionStorage, context);
}
export function useTeachingContext(initial: Partial<TeachingContext> = {}) {
  const initialRef = useRef(initial);
  const [context, setContextState] = useState<TeachingContext>({ ...emptyTeachingContext, ...initial });
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const fromUrl = readContext();
    const stored = readStoredTeachingContext(window.sessionStorage);
    const restored = hasTeachingContext(window.location.search) ? fromUrl : stored ?? fromUrl;
    const value = { ...emptyTeachingContext, ...initialRef.current, ...restored };
    setContextState(value);
    writeContext(value);
    setHydrated(true);
  }, []);
  const setContext = useCallback((next: TeachingContext | ((current: TeachingContext) => TeachingContext)) => setContextState((current) => { const value = typeof next === "function" ? next(current) : next; writeContext(value); return value; }), []);
  return {
    context,
    hydrated,
    setContext,
    setSemesterId: useCallback((semesterId: string) => setContext((current) => current.semesterId === semesterId ? current : { semesterId, className: "", classId: "", sessionCode: "" }), [setContext]),
    setClassName: useCallback((className: string) => setContext((current) => current.className === className ? current : { ...current, className, classId: "", sessionCode: "" }), [setContext]),
    setSessionCode: useCallback((sessionCode: string) => setContext((current) => current.sessionCode === sessionCode ? current : { ...current, sessionCode }), [setContext]),
  };
}
