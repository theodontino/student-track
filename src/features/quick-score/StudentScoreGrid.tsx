import { DIM_CONFIG, SCORE_COLORS } from "@/lib/constants";
import type { CardScore } from "@/lib/types";

interface Props {
  cards: CardScore[];
  genders: Map<string, string>;
  onScore: (index: number, dimension: "A" | "B" | "C", value: number) => void;
  onPresent: (index: number) => void;
  onNote: (index: number, note: string) => void;
}

export default function StudentScoreGrid({ cards, genders, onScore, onPresent, onNote }: Props) {
  return <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{cards.map((card, index) => {
    const changed = card.scoreA !== 3 || card.scoreB !== 3 || card.scoreC !== 3;
    return <div key={card.studentId} className={`rounded-lg border bg-white p-3 ${changed || !card.present ? "border-blue-300 shadow-sm" : "border-gray-200"} ${!card.present ? "ring-1 ring-red-300" : ""}`}>
      <div className="mb-2 flex items-center gap-2"><div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${genders.get(card.studentId) === "男" ? "bg-blue-500" : "bg-pink-500"}`}>{card.studentName[0]}</div><span className="flex-1 truncate text-sm font-medium text-gray-800">{card.studentName}</span><button onClick={() => onPresent(index)} title={card.present ? "点击标记缺勤" : "点击标记出勤"} className={`rounded px-2 py-0.5 text-xs font-medium ${card.present ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>{card.present ? "✓ 到" : "✕ 缺"}</button></div>
      <div className="space-y-1.5">{DIM_CONFIG.map((dimension) => { const score = card[`score${dimension.key}` as keyof CardScore] as number; return <div key={dimension.key} className="flex items-center gap-1"><span className="w-6 shrink-0 text-xs text-gray-400">{dimension.label}</span>{[0,1,2,3,4,5].map((value) => <button key={value} onClick={() => onScore(index, dimension.key, value)} className={`h-6 w-6 rounded text-[10px] font-medium ${value === score ? `${SCORE_COLORS[value]} scale-110 text-white shadow-sm` : "text-gray-300 hover:bg-gray-100 hover:text-gray-500"}`}>{value}</button>)}</div>; })}</div>
      <div className="mt-2">{card.note.length > 0 ? <textarea value={card.note} onChange={(event) => onNote(index, event.target.value)} rows={2} placeholder="备注" className="w-full resize-none rounded border border-gray-200 px-2 py-1 text-xs" /> : <button onClick={() => onNote(index, " ")} className="text-xs text-gray-300 hover:text-gray-500">+ 备注</button>}</div>
    </div>;
  })}</div>;
}
