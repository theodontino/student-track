export type PaletteId = "classic" | "midnight" | "nebula" | "balanced-nebula";

export interface PaletteDefinition {
  id: PaletteId;
  label: "经典" | "暮蓝" | "星云" | "平衡星云";
  mode: "light" | "dark";
  description: string;
}

export const PALETTE_STORAGE_KEY = "chem-track:palette";
export const DEFAULT_PALETTE: PaletteId = "balanced-nebula";

export const PALETTES: readonly PaletteDefinition[] = [
  { id: "classic", label: "经典", mode: "light", description: "熟悉的明亮蓝白界面，保留旧版状态与图表色彩。" },
  { id: "midnight", label: "暮蓝", mode: "dark", description: "深蓝黑画布与克制紫光，适合长时间专注工作。" },
  { id: "nebula", label: "星云", mode: "dark", description: "紫色环境光最鲜明，功能控件仍保持清晰亮蓝。" },
  { id: "balanced-nebula", label: "平衡星云", mode: "dark", description: "蓝灰内容与紫色氛围平衡，是默认的深色工作台。" },
] as const;

export function isPaletteId(value: unknown): value is PaletteId {
  return PALETTES.some((palette) => palette.id === value);
}

export function resolvePalette(value: unknown): PaletteId {
  return isPaletteId(value) ? value : DEFAULT_PALETTE;
}
