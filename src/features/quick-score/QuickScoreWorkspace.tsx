"use client";

import { EmptyState } from "@/components/ui";
import BulkScoreToolbar from "./BulkScoreToolbar";
import { QuickScoreContextPanel } from "./QuickScoreContextPanel";
import SaveBar from "./SaveBar";
import StudentScoreGrid from "./StudentScoreGrid";
import { useQuickScorePage } from "./useQuickScorePage";

export default function QuickScoreWorkspace() {
  const workspace = useQuickScorePage();
  return (
    <main className="quick-score-workspace">
      <QuickScoreContextPanel workspace={workspace} />

      {workspace.selectedClass && workspace.cards.length > 0 && (
        <>
          <BulkScoreToolbar
            cards={workspace.cards}
            changedCount={workspace.changedCount}
            absentCount={workspace.absentCount}
            onSet={workspace.bulkSet}
          />
          <StudentScoreGrid
            cards={workspace.cards}
            genders={workspace.genders}
            onScore={workspace.setScore}
            onPresent={workspace.togglePresent}
            onNote={workspace.setNote}
          />
          <SaveBar
            total={workspace.cards.length}
            changed={workspace.changedCount}
            submitting={workspace.submitting}
            result={workspace.result}
            onSave={() => void workspace.handleSubmit()}
          />
        </>
      )}

      {workspace.selectedClass && workspace.cards.length === 0 && (
        <EmptyState title="该班级暂无学生" description="请先在学生档案中添加学生，或切换到其他班级。" />
      )}
      {!workspace.selectedClass && (
        <EmptyState title="请选择学期和班级" description="选择后会自动载入最近课次与学生名单。" />
      )}
    </main>
  );
}
