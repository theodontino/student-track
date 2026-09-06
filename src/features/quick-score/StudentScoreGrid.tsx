import { DIM_CONFIG } from "@/lib/constants";
import type { CardScore } from "@/lib/types";

interface Props {
  cards: CardScore[];
  genders: Map<string, string>;
  onScore: (index: number, dimension: "A" | "B" | "C", value: number) => void;
  onPresent: (index: number) => void;
  onNote: (index: number, note: string) => void;
}

export default function StudentScoreGrid({ cards, genders, onScore, onPresent, onNote }: Props) {
  return (
    <div className="quick-score-grid">
      {cards.map((card, index) => {
        const changed = card.scoreA !== 3 || card.scoreB !== 3 || card.scoreC !== 3 || Boolean(card.note.trim());
        return (
          <article key={card.studentId} className={`quick-score-card ${changed || !card.present ? "is-changed" : ""} ${!card.present ? "is-absent" : ""}`}>
            <header>
              <div className={`quick-score-card__avatar ${genders.get(card.studentId) === "男" ? "is-male" : "is-female"}`} aria-hidden="true">{card.studentName[0]}</div>
              <span className="quick-score-card__name">{card.studentName}</span>
              <button type="button" onClick={() => onPresent(index)} title={card.present ? "点击标记缺勤" : "点击标记出勤"} className={`quick-score-attendance ${card.present ? "is-present" : "is-absent"}`}>
                {card.present ? "✓ 到" : "✕ 缺"}
              </button>
            </header>
            <div className="quick-score-card__dimensions">
              {DIM_CONFIG.map((dimension) => {
                const score = card[`score${dimension.key}` as keyof CardScore] as number;
                return (
                  <div key={dimension.key} className="quick-score-card__dimension">
                    <span>{dimension.label}{dimension.key === "A" && !Number.isInteger(score) ? <em>{score.toFixed(1)}</em> : null}</span>
                    <div>{[0, 1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={value}
                        type="button"
                        data-score={value}
                        onClick={() => onScore(index, dimension.key, value)}
                        className={`quick-score-card__value ${value === score ? "scale-110 is-selected" : ""}`}
                      >
                        {value}
                      </button>
                    ))}</div>
                  </div>
                );
              })}
            </div>
            <div className="quick-score-card__note">
              {card.note.length > 0 ? (
                <textarea aria-label={`${card.studentName}备注`} value={card.note} onChange={(event) => onNote(index, event.target.value)} rows={2} placeholder="备注" />
              ) : (
                <button type="button" onClick={() => onNote(index, " ")}>+ 添加备注</button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}
