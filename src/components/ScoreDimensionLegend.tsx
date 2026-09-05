import { SCORE_DIMENSION_DETAILS } from "@/lib/constants";

export function ScoreDimensionLegend({ showAssessmentRule = false }: { showAssessmentRule?: boolean }) {
  return (
    <section className="score-dimension-legend" aria-label="A B C D 评分维度说明">
      <header>
        <strong>A/B/C/D 分别是什么</strong>
        {showAssessmentRule && <span>个人出门测唯一匹配后，A = 正确率 ÷ 20，自动保留一位小数；与已有分数不一致时会请教师选择。</span>}
      </header>
      <dl>
        {SCORE_DIMENSION_DETAILS.map((dimension) => (
          <div key={dimension.key}>
            <dt><b>{dimension.key}</b>{dimension.label}</dt>
            <dd>{dimension.description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
