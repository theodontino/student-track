"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { DEFAULT_PALETTE, PALETTES, PALETTE_STORAGE_KEY, resolvePalette, type PaletteId } from "./palettes";

interface PaletteContextValue {
  palette: PaletteId;
  setPalette: (palette: PaletteId) => void;
}

const PaletteContext = createContext<PaletteContextValue | null>(null);

function initialPalette(): PaletteId {
  if (typeof document === "undefined") return DEFAULT_PALETTE;
  return resolvePalette(document.documentElement.dataset.palette);
}

export function PaletteProvider({ children }: { children: React.ReactNode }) {
  const [palette, setPaletteState] = useState<PaletteId>(initialPalette);
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
