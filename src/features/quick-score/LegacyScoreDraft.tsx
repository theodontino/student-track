import type { CardScore } from "@/lib/types";
import { SCORE_FIELDS, type ScoreField } from "./score-changes";

const labels: Record<ScoreField, string> = { scoreA: "A", scoreB: "B", scoreC: "C", present: "考勤", note: "备注" };

export function LegacyScoreDraft({ cards, currentCards, onRestore, onDismiss }: {
  cards: CardScore[];
  currentCards: CardScore[];
  onRestore: (studentId: string, field: ScoreField) => void;
  onDismiss: () => void;
}) {
  if (cards.length === 0) return null;
  return (
    <details className="rounded-lg border p-3 my-3">
      <summary>旧版草稿（未自动恢复）</summary>
      <p>当前显示的是最新评分。旧草稿没有记录修改了哪些维度，请只恢复你需要的字段。</p>
      {cards.map((card) => (
        <div key={card.studentId} className="my-2 flex flex-wrap items-center gap-2">
          <strong>{card.studentName}</strong>
          {SCORE_FIELDS.map((field) => {
            const value = field === "present" ? card.present ? "出勤" : "缺勤" : String(card[field]);
            if (field === "note" && !value.trim()) return null;
            return (
              <button key={field} type="button" className="rounded border px-2 py-1"
                disabled={!currentCards.some((current) => current.studentId === card.studentId)}
                aria-label={`恢复${card.studentName}的${labels[field]}为${value}`}
                onClick={() => onRestore(card.studentId, field)}>
                恢复 {labels[field]}：{value}
              </button>
            );
          })}
        </div>
      ))}
      <button type="button" onClick={onDismiss}>不再保留这份旧草稿</button>
    </details>
  );
}
