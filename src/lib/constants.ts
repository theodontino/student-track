// v0.13.1: 共享常量 — 跨页面复用的标签/颜色/维度定义

export const PRESET_TAGS = [
  "#逻辑强", "#基础弱", "#主动", "#被动", "#调皮",
  "#敏感", "#内向", "#外向", "#注意力差", "#爱发言",
];

export const DIM_LABEL: Record<string, string> = {
  A: "学习&测验",
  B: "精神&纪律",
  C: "课后任务",
};

export const DIM_SHORT: Record<string, string> = {
  A: "学习",
  B: "纪律",
  C: "作业",
};

export const DIM_CONFIG = [
  { key: "A" as const, label: "学习", color: "bg-blue-500" },
  { key: "B" as const, label: "纪律", color: "bg-green-500" },
  { key: "C" as const, label: "作业", color: "bg-amber-500" },
];

export const SCORE_COLORS = [
  "bg-red-400", "bg-red-300", "bg-orange-300",
  "bg-yellow-300", "bg-lime-400", "bg-green-400",
];

export const PRESET_LABEL_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-green-100 text-green-700",
  "bg-amber-100 text-amber-700",
  "bg-purple-100 text-purple-700",
  "bg-pink-100 text-pink-700",
  "bg-cyan-100 text-cyan-700",
];
