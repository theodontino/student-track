"use client";

import { PageHeader } from "@/components/ui";
import { PALETTES, type PaletteId } from "./palettes";
import { usePalette } from "./PaletteProvider";

const samples: Record<PaletteId, readonly string[]> = {
  classic: ["#f6f8fc", "#ffffff", "#2563eb", "#16a34a", "#d97706"],
  midnight: ["#070b14", "#0e1626", "#49a7ff", "#7f78e8", "#e3a14c"],
  nebula: ["#0d0716", "#171024", "#58adff", "#a76bff", "#e8a34b"],
  "balanced-nebula": ["#080a12", "#111624", "#4fa8ff", "#966cff", "#e6a24b"],
};

export default function AppearancePanel() {
  const { palette, setPalette } = usePalette();
  return (
    <main className="appearance-workspace">
      <PageHeader title="外观" description="选择工作台配色。设置只保存在当前浏览器，不写入业务数据库。" />
      <div className="appearance-grid" role="radiogroup" aria-label="界面配色">
        {PALETTES.map((item) => {
          const selected = palette === item.id;
          return (
            <button key={item.id} type="button" role="radio" aria-checked={selected} className={`appearance-option${selected ? " is-selected" : ""}`} onClick={() => setPalette(item.id)}>
              <span className="appearance-option__preview" data-preview-palette={item.id}>
                <span className="appearance-option__sidebar" />
                <span className="appearance-option__content"><i /><i /><i /></span>
              </span>
              <span className="appearance-option__copy"><strong>{item.label}</strong><small>{item.description}</small></span>
              <span className="appearance-swatches" aria-hidden="true">{samples[item.id].map((color) => <i key={color} style={{ background: color }} />)}</span>
              <span className="appearance-option__state">{selected ? "正在使用" : "立即应用"}</span>
            </button>
          );
        })}
      </div>
    </main>
  );
}
