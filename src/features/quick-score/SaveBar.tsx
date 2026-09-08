import { ActionBar, Button, SaveStateIndicator } from "@/components/ui";

export default function SaveBar({ total, changed, submitting, result, onSave }: { total: number; changed: number; submitting: boolean; result: { count: number; attUpdated: number } | null; onSave: () => void }) {
  const state = submitting ? "saving" : result ? "saved" : changed > 0 ? "dirty" : "clean";
  return (
    <ActionBar className="quick-score-savebar">
      <div>
        <SaveStateIndicator state={state} />
        {result ? (
          <p>已提交 {result.count} 条评分{result.attUpdated > 0 && <span> · 更新 {result.attUpdated} 条考勤</span>}</p>
        ) : (
          <p>本次仅保存 <strong>{changed}</strong> / {total} 名学生修改的维度、考勤与备注</p>
        )}
      </div>
      <Button uiSize="lg" onClick={onSave} disabled={submitting || changed === 0}>{submitting ? "提交中…" : "全部提交"}</Button>
    </ActionBar>
  );
}
