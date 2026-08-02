"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Section, StatusBanner } from "@/components/ui";
import { requestJson } from "@/lib/api-client";

interface TeacherTask {
  id: string;
  action: string;
  status: string;
  dueDate?: string | null;
  dueSession?: { id: string; code: string; date: string; semesterNumber: number } | null;
  student?: { name: string } | null;
}

export default function TeacherTaskPanel({ semesterId }: { semesterId?: string }) {
  const [tasks, setTasks] = useState<TeacherTask[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const query = semesterId ? `?semesterId=${encodeURIComponent(semesterId)}` : "";
      setTasks((await requestJson<{ tasks: TeacherTask[] }>(`/api/teacher-tasks${query}`)).tasks);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取教师任务失败"); }
  }, [semesterId]);
  useEffect(() => { void load(); }, [load]);
  async function update(id: string, status: "completed" | "cancelled") {
    try {
      await requestJson(`/api/report/feedback-plans/task/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "更新教师任务失败"); }
  }
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const dueValue = (task: TeacherTask) => task.dueSession?.date ?? task.dueDate ?? "";
  const pending = tasks.filter((task) => task.status === "pending");
  const overdue = pending.filter((task) => dueValue(task) && dueValue(task) < today);
  const todayTasks = pending.filter((task) => dueValue(task) === today);
  const completed = tasks.filter((task) => task.status === "completed");
  const cancelled = tasks.filter((task) => task.status === "cancelled");
  const futureTasks = pending
    .filter((task) => !overdue.includes(task) && dueValue(task) > today)
    .sort((left, right) => dueValue(left).localeCompare(dueValue(right)));
  const nextSession = futureTasks.filter((task) => task.dueSession).sort((left, right) => dueValue(left).localeCompare(dueValue(right)))[0]?.dueSession;
  const nextTasks = nextSession ? futureTasks.filter((task) => task.dueSession?.id === nextSession.id) : [];
  const nextTaskIds = new Set(nextTasks.map((task) => task.id));
  const laterTasks = futureTasks.filter((task) => !nextTaskIds.has(task.id));
  const groups: Array<[string, TeacherTask[]]> = [
    ["逾期", overdue],
    ["今日", todayTasks],
    ["下次课", nextTasks],
    ["更晚待办", laterTasks],
    ["已完成", completed],
    ["已取消", cancelled],
  ];
  const renderTask = (task: TeacherTask) => <div key={task.id} className="flex items-center justify-between gap-3 rounded border border-gray-200 p-3 text-sm"><span><strong>{task.student?.name || "班级"}</strong>：{task.action}<small className="ml-2 text-gray-500">{task.dueSession ? `${task.dueSession.date} ${task.dueSession.code}` : task.dueDate || "未设截止"}</small></span><span className="flex items-center gap-2"><Badge tone={task.status === "pending" ? "warning" : "success"}>{task.status}</Badge>{task.status === "pending" && <><Button uiSize="sm" onClick={() => void update(task.id, "completed")}>完成</Button><Button uiSize="sm" variant="secondary" onClick={() => void update(task.id, "cancelled")}>取消</Button></>}</span></div>;
  return <Section title="教师待办" description="反馈中批准的未来动作只在这里出现，不会把观察记录当成任务。">{error && <StatusBanner tone="danger">{error}</StatusBanner>}{tasks.length === 0 ? <p className="text-sm text-gray-500">暂无待处理任务</p> : <div className="space-y-4">{groups.map(([label, group]) => group.length ? <div key={label}><h3 className="mb-2 text-xs font-semibold text-gray-500">{label}（{group.length}）</h3><div className="space-y-2">{group.map(renderTask)}</div></div> : null)}</div>}</Section>;
}
