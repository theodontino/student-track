"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { readSSEStream } from "@/lib/sse";
import { useSessionWorkspace } from "@/lib/use-session-workspace";
import { useUnsavedNavigationWarning } from "@/lib/use-unsaved-navigation-warning";
import {
  createDiarizeTask,
  deleteDiarizeTask,
  loadDiarizeTask,
  loadDiarizeTasks,
  retryDiarizeTask,
} from "./diarize-api";
import { DiarizeTaskComposer } from "./DiarizeTaskComposer";
import { DiarizeRunLog, DiarizeTaskDetail } from "./DiarizeTaskDetail";
import { DiarizeTaskList } from "./DiarizeTaskList";
import {
  isDiarizeSessionState,
  type DiarizeEngine,
  type DiarizeSessionState,
  type DiarizeTask,
} from "./diarize-types";
import { useAudioRecorder } from "./use-audio-recorder";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export default function DiarizeWorkspace() {
  const router = useRouter();
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [engine, setEngine] = useState<DiarizeEngine>("auto");
  const [tasks, setTasks] = useState<DiarizeTask[]>([]);
  const [activeTask, setActiveTask] = useState<DiarizeTask | null>(null);
  const [logs, setLogs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const recorder = useAudioRecorder({ onRecorded: setAudioFile, onError: setError, onStatus: setStatus });
  const workspaceValue = useMemo<DiarizeSessionState>(() => ({ engine, activeTaskId: activeTask?.id ?? "" }), [activeTask?.id, engine]);

  useSessionWorkspace({
    key: "diarize",
    value: workspaceValue,
    validate: isDiarizeSessionState,
    restore: (saved) => {
      if (!saved) return;
      setEngine(saved.engine);
      if (saved.activeTaskId) void openTask(saved.activeTaskId);
    },
  });
  useUnsavedNavigationWarning(
    recorder.state === "recording" || Boolean(audioFile && !activeTask),
    "当前录音或尚未提交的音频文件不能由浏览器自动恢复。确定离开此页面吗？",
  );

  useEffect(() => { void refreshTasks(); }, []);

  async function refreshTasks() {
    try {
      setTasks(await loadDiarizeTasks());
    } catch (reason) {
      setError(errorMessage(reason, "读取转写任务失败"));
    }
  }

  function updateTaskInList(task: DiarizeTask) {
    setTasks((current) => {
      const exists = current.some((item) => item.id === task.id);
      const next = exists ? current.map((item) => item.id === task.id ? task : item) : [task, ...current];
      return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async function consumeTaskStream(response: Response) {
    if (!response.body) throw new Error("转写任务流不可用");
    await readSSEStream(response.body.getReader(), (event) => {
      if (event.type === "created" || event.type === "task") {
        setActiveTask(event.task);
        updateTaskInList(event.task);
      } else if (event.type === "log") {
        setLogs((current) => current + event.content);
      } else if (event.type === "done") {
        setActiveTask(event.task);
        updateTaskInList(event.task);
        setStatus("转写完成。");
      } else if (event.type === "error") {
        if (event.task) {
          setActiveTask(event.task);
          updateTaskInList(event.task);
        }
        setError(event.message || "转写失败");
      }
    });
    await refreshTasks();
  }

  async function startTask() {
    if (!audioFile) { setError("请先选择音频文件"); return; }
    setBusy(true);
    setError("");
    setStatus("");
    setLogs("");
    setActiveTask(null);
    try {
      await consumeTaskStream(await createDiarizeTask(audioFile, engine));
    } catch (reason) {
      setError(errorMessage(reason, "创建转写任务失败"));
    } finally {
      setBusy(false);
    }
  }

  async function openTask(taskId: string) {
    setError("");
    setStatus("");
    try {
      const task = await loadDiarizeTask(taskId);
      setActiveTask(task);
      setLogs(task.log || "");
    } catch (reason) {
      setError(errorMessage(reason, "读取任务失败"));
    }
  }

  async function retryTask(taskId: string) {
    setBusy(true);
    setError("");
    setStatus("");
    setLogs("");
    try {
      await consumeTaskStream(await retryDiarizeTask(taskId));
    } catch (reason) {
      setError(errorMessage(reason, "重试失败"));
    } finally {
      setBusy(false);
    }
  }

  async function removeTask(taskId: string) {
    try {
      await deleteDiarizeTask(taskId);
      setTasks((current) => current.filter((task) => task.id !== taskId));
      if (activeTask?.id === taskId) {
        setActiveTask(null);
        setLogs("");
      }
      setStatus("转写任务已删除。");
    } catch (reason) {
      setError(errorMessage(reason, "删除任务失败"));
    }
  }

  async function copyResult() {
    if (!activeTask?.resultText) return;
    await navigator.clipboard.writeText(activeTask.resultText);
    setStatus("文字稿已复制。");
  }

  function downloadResult() {
    if (!activeTask?.resultText) return;
    const blob = new Blob([activeTask.resultText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeTask.title.replace(/\.[^.]+$/, "") || "diarize"}_transcript.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function sendResult(storageKey: "chem-track:nl-input-draft" | "chem-track:feedback-draft", path: string) {
    if (!activeTask?.resultText) return;
    sessionStorage.setItem(storageKey, activeTask.resultText);
    router.push(path);
  }

  return (
    <main className="diarize-workspace">
      <PageHeader title="录音转写" description="把课后回顾录音转成文字稿，再送入课堂录入或课后反馈。" />
      <p className="diarize-workspace__note">转写方式和任务编号会在切换页面后恢复；浏览器不会保存未提交的音频文件，离开前会提醒。</p>
      <div className="diarize-workspace__layout">
        <DiarizeTaskList tasks={tasks} busy={busy} onRefresh={() => void refreshTasks()} onOpen={(taskId) => void openTask(taskId)} onRetry={(taskId) => void retryTask(taskId)} onDelete={(taskId) => void removeTask(taskId)} />
        <div className="diarize-workspace__detail">
          <DiarizeTaskComposer
            audioFile={audioFile}
            engine={engine}
            busy={busy}
            activeTask={activeTask}
            recordingState={recorder.state}
            recordingSeconds={recorder.seconds}
            status={status}
            error={error}
            onAudioFileChange={(file) => { setAudioFile(file); recorder.selectFile(); }}
            onEngineChange={setEngine}
            onStartRecording={() => void recorder.start()}
            onStopRecording={recorder.stop}
            onDiscardRecording={() => { recorder.discard(); setAudioFile(null); }}
            onStartTask={() => void startTask()}
            onRetryTask={(taskId) => void retryTask(taskId)}
          />
          {activeTask && <DiarizeTaskDetail task={activeTask} onCopy={() => void copyResult()} onDownload={downloadResult} onSendToFeedback={() => sendResult("chem-track:feedback-draft", "/feedback")} onSendToInput={() => sendResult("chem-track:nl-input-draft", "/input")} />}
          <DiarizeRunLog logs={logs} />
        </div>
      </div>
    </main>
  );
}
