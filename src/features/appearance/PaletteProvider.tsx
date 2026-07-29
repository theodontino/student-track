"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from "react";
import { DEFAULT_PALETTE, PALETTES, PALETTE_STORAGE_KEY, resolvePalette, type PaletteId } from "./palettes";

interface PaletteContextValue {
  palette: PaletteId;
  setPalette: (palette: PaletteId) => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

export function PaletteProvider({ children }: { children: React.ReactNode }) {
  // 首次服务端与客户端渲染必须一致；head 中的同步脚本已经在首帧前设置
  // html 配色，这里只在 hydration 前同步 React 状态，避免外观页重绘告警。
  const [palette, setPaletteState] = useState<PaletteId>(DEFAULT_PALETTE);
  useLayoutEffect(() => {
    setPaletteState(resolvePalette(document.documentElement.dataset.palette));
  }, []);
  const setPalette = useCallback((next: PaletteId) => {
    const resolved = resolvePalette(next);
    const definition = PALETTES.find((item) => item.id === resolved);
    document.documentElement.dataset.palette = resolved;
    document.documentElement.style.colorScheme = definition?.mode ?? "dark";
    window.localStorage.setItem(PALETTE_STORAGE_KEY, resolved);
    setPaletteState(resolved);
  }, []);
  const value = useMemo(() => ({ palette, setPalette }), [palette, setPalette]);
  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}

export function usePalette() {
  const value = useContext(PaletteContext);
  if (!value) throw new Error("usePalette must be used within PaletteProvider");
  return value;
}
