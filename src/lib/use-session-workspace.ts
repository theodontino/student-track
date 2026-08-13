"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  readSessionWorkspace,
  removeSessionWorkspace,
  writeSessionWorkspace,
} from "./session-workspace";

interface SessionWorkspaceOptions<T> {
  key: string;
  value: T;
  restore: (value: T | null) => void;
  validate: (value: unknown) => value is T;
  version?: number;
  enabled?: boolean;
}

export function useSessionWorkspace<T>({
  key,
  value,
  restore,
  validate,
  version = 1,
  enabled = true,
}: SessionWorkspaceOptions<T>) {
  const restoreRef = useRef(restore);
  const validateRef = useRef(validate);
  const pendingWriteRef = useRef<{ key: string; value: T; version: number } | null>(null);
  const writeTimerRef = useRef<number | null>(null);
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  const [restoredAt, setRestoredAt] = useState<string | null>(null);

  const flushPendingWrite = useCallback(() => {
    if (writeTimerRef.current !== null) {
      window.clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    const pending = pendingWriteRef.current;
    if (!pending) return;
    pendingWriteRef.current = null;
    writeSessionWorkspace(window.sessionStorage, pending.key, pending.version, pending.value);
  }, []);

  useEffect(() => {
    restoreRef.current = restore;
    validateRef.current = validate;
  }, [restore, validate]);

  useEffect(() => {
    flushPendingWrite();
    if (!enabled) {
      setHydratedKey(null);
      return;
    }
    const envelope = readSessionWorkspace(window.sessionStorage, key, version, validateRef.current);
    restoreRef.current(envelope?.value ?? null);
    setRestoredAt(envelope?.savedAt ?? null);
    setHydratedKey(key);
  }, [enabled, flushPendingWrite, key, version]);

  useEffect(() => {
    if (!enabled || hydratedKey !== key) return;
    pendingWriteRef.current = { key, value, version };
    if (writeTimerRef.current !== null) window.clearTimeout(writeTimerRef.current);
    writeTimerRef.current = window.setTimeout(flushPendingWrite, 300);
  }, [enabled, flushPendingWrite, hydratedKey, key, value, version]);

  useEffect(() => {
    const flush = () => flushPendingWrite();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flushPendingWrite();
    };
  }, [flushPendingWrite]);

  return {
    hydrated: enabled && hydratedKey === key,
    restoredAt,
    clear() {
      if (pendingWriteRef.current?.key === key) {
        pendingWriteRef.current = null;
        if (writeTimerRef.current !== null) {
          window.clearTimeout(writeTimerRef.current);
          writeTimerRef.current = null;
        }
      }
      removeSessionWorkspace(window.sessionStorage, key);
      setRestoredAt(null);
    },
  };
}
