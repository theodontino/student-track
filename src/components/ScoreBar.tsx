// v0.13.1: 评分进度条组件
interface Props { score: number; color: string; }
export default function ScoreBar({ score, color }: Props) {
  return (
    <div className="flex items-center gap-1" title={`${score}/5`}>
      <div className="w-8 h-1.5 rounded-full bg-gray-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${(score / 5) * 100}%` }} />
      </div>
      <span className="text-[10px] font-mono text-gray-500 w-3 text-right">{score}</span>
    </div>
  );
}

export function ScoreBars({ scores }: { scores: { scoreA: number; scoreB: number; scoreC: number; scoreD: number } }) {
  return (
    <div className="flex items-center gap-2">
      <ScoreBar score={scores.scoreA} color="bg-blue-400" />
      <ScoreBar score={scores.scoreB} color="bg-green-400" />
      <ScoreBar score={scores.scoreC} color="bg-amber-400" />
      <ScoreBar score={scores.scoreD} color="bg-purple-400" />
    </div>
  );
}
