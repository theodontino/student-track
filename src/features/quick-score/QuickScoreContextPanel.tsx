"use client";

import WorkHistoryButton from "@/components/WorkHistoryButton";
import { SemesterDialog } from "@/features/courses";
import ContextHeader from "./ContextHeader";
import type { QuickScoreHistoryState, QuickScoreSemester } from "./types";
import type { useQuickScorePage } from "./useQuickScorePage";

type Workspace = ReturnType<typeof useQuickScorePage>;

export function QuickScoreContextPanel({ workspace }: { workspace: Workspace }) {
  const controlsReady = workspace.contextHydrated && workspace.workspaceHydrated;
  return (
    <>
      <ContextHeader
        semesterName={workspace.selectedSemester?.name}
        sessionCount={workspace.selectedSemester?.sessionCount}
        history={<WorkHistoryButton<QuickScoreHistoryState> module="quick-score" onRestore={workspace.restoreHistory} />}
      >
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <select
            aria-label="学期"
            value={workspace.selectedSemesterId}
            disabled={!controlsReady}
            onChange={(event) => workspace.setSelectedSemesterId(event.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"
          >
            {workspace.semesters.map((semester) => (
              <option key={semester.id} value={semester.id}>{semester.name}</option>
            ))}
          </select>
          <button
            type="button"
            aria-label="新建学期"
            onClick={() => workspace.setShowSemesterModal(true)}
            className="border border-gray-300 text-gray-500 px-2 py-2 rounded-lg text-sm hover:bg-gray-50"
            title="新建学期"
          >+</button>

          <select
            aria-label="班级"
            value={workspace.selectedClass}
            disabled={!controlsReady}
            onChange={(event) => workspace.setSelectedClass(event.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none"
          >
            <option value="">选择班级</option>
            {workspace.classes.map((className) => (
              <option key={className} value={className}>{className}</option>
            ))}
          </select>

          {workspace.selectedClass && workspace.sessions.length > 0 && (
            <>
              <span className="text-xs text-gray-400">课次</span>
              <select
                aria-label="课次"
                value={workspace.selectedSessionCode}
                onChange={(event) => void workspace.handleSessionChange(event.target.value)}
                className="border border-blue-300 rounded-lg px-3 py-2 text-sm font-mono outline-none bg-blue-50"
              >
                {workspace.sessions.map((session) => (
                  <option key={session.code} value={session.code}>
                    {session.code} — 第{session.semesterNumber}次课
                  </option>
                ))}
              </select>
            </>
          )}

          {workspace.selectedSessionCode && (
            <button
              type="button"
              onClick={workspace.requestDeleteSession}
              disabled={workspace.deletingSession}
              className="border border-red-200 text-red-600 px-3 py-2 rounded-lg text-sm hover:bg-red-50 disabled:opacity-50"
              title="删除当前课次"
            >{workspace.deletingSession ? "删除中…" : "删除课次"}</button>
          )}
          <button
            type="button"
            onClick={() => void workspace.handleRecordClass()}
            disabled={workspace.recordingClass || !workspace.selectedSemesterId || !workspace.selectedClass}
            className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >{workspace.recordingClass ? "记录中…" : "开始上课"}</button>
        </div>

        {workspace.selectedSession && (
          <div className="flex items-center gap-3 mb-4 text-xs text-gray-500">
            <span>日期</span>
            <input
              aria-label="日期"
              type="date"
              value={workspace.date}
              onChange={(event) => {
                workspace.setDate(event.target.value);
                workspace.setSelectedSessionCode("");
              }}
              className="border border-gray-300 rounded px-2 py-1 text-xs outline-none"
            />
            <span className="text-gray-400">
              学期内第 {workspace.selectedSession.semesterNumber} 次课
              {workspace.selectedSession.class && <span className="ml-1">· {workspace.selectedSession.class}</span>}
              <span className="ml-1">· 考勤 {workspace.selectedSession.attendanceCount} 人</span>
            </span>
            {workspace.hasExistingScores && (
              <span className="text-amber-600 text-xs font-medium">已有评分记录，提交将覆盖</span>
            )}
          </div>
        )}
      </ContextHeader>

      <SemesterDialog
        open={workspace.showSemesterModal}
        onClose={() => workspace.setShowSemesterModal(false)}
        onSaved={(semester) => {
          workspace.setSemesters((current) => [semester as QuickScoreSemester, ...current]);
          workspace.setSelectedSemesterId(semester.id);
        }}
      />
    </>
  );
}
