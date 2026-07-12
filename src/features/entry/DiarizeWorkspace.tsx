"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { readSSEStream } from "@/lib/sse";

type DiarizeEngine = "auto" | "local" | "tingwu";
type DiarizeTaskStatus = "queued" | "running" | "succeeded" | "failed";

interface DiarizeTask {
  id: string;
  title: string;
  engine: DiarizeEngine;
  speakerCount: number | null;
  status: DiarizeTaskStatus;
  inputFileName: string;
  retryOf: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  hasResultText: boolean;
  hasResultJson: boolean;
  resultText?: string;
  log?: string;
}

const ENGINES: { value: DiarizeEngine; label: string; note: string }[] = [
  { value: "auto", label: "自动", note: "先云端，失败后降级" },
  { value: "local", label: "本地", note: "不上传云端" },
  { value: "tingwu", label: "听悟", note: "使用阿里云" },
];

const STATUS_LABEL: Record<DiarizeTaskStatus, string> = {
  queued: "等待中",
  running: "处理中",
  succeeded: "完成",
  failed: "失败",
};

const STATUS_CLASS: Record<DiarizeTaskStatus, string> = {
  queued: "bg-gray-100 text-gray-600",
  running: "bg-blue-50 text-blue-700",
  succeeded: "bg-green-50 text-green-700",
  failed: "bg-red-50 text-red-700",
};

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function formatDuration(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function preferredRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function recordingExtension(mimeType: string) {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
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
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "recorded">("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<BlobPart[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const recordingSecondsRef = useRef(0);

  useEffect(() => {
    loadTasks();
  }, []);

  useEffect(() => {
    return () => {
      stopRecordingTimer();
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function loadTasks() {
    const res = await fetch("/api/diarize/tasks");
    const data = await res.json();
    setTasks(data.tasks || []);
  }

  function updateTaskInList(task: DiarizeTask) {
    setTasks((current) => {
      const exists = current.some((item) => item.id === task.id);
      const next = exists ? current.map((item) => item.id === task.id ? task : item) : [task, ...current];
      return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  async function consumeTaskStream(response: Response) {
    await readSSEStream(response.body!.getReader(), (event) => {
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
    await loadTasks();
  }

  async function startTask() {
    if (!audioFile) { setError("请先选择音频文件"); return; }
    setBusy(true);
    setError("");
    setStatus("");
    setLogs("");
    setActiveTask(null);

    const formData = new FormData();
    formData.append("audio", audioFile);
    formData.append("engine", engine);

    try {
      const res = await fetch("/api/diarize/tasks", { method: "POST", body: formData });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "创建转写任务失败");
      }
      await consumeTaskStream(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "创建转写任务失败");
    } finally {
      setBusy(false);
    }
  }

  function stopRecordingTimer() {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }

  async function startRecording() {
    if (busy || recordingState === "recording") return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("当前浏览器不支持现场录音");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError("当前浏览器不支持 MediaRecorder 录音");
      return;
    }

    setError("");
    setStatus("");
    recordingChunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredRecordingMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recordingStreamRef.current = stream;
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stopRecordingTimer();
        stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
        recorderRef.current = null;

        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(recordingChunksRef.current, { type });
        if (blob.size === 0) {
          setError("录音内容为空，请重试");
          setRecordingState("idle");
          return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = new File([blob], `现场录音-${timestamp}.${recordingExtension(type)}`, { type });
        setAudioFile(file);
        setRecordingState("recorded");
        setStatus(`现场录音已就绪，时长 ${formatDuration(recordingSecondsRef.current)}。`);
      };

      setRecordingSeconds(0);
      recordingSecondsRef.current = 0;
      setRecordingState("recording");
      recorder.start(1000);
      recordingTimerRef.current = window.setInterval(() => {
        recordingSecondsRef.current += 1;
        setRecordingSeconds(recordingSecondsRef.current);
      }, 1000);
    } catch (e: unknown) {
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      setRecordingState("idle");
      setError(e instanceof DOMException && e.name === "NotAllowedError" ? "麦克风权限被拒绝" : e instanceof Error ? e.message : "无法开始录音");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  }

  function discardRecording() {
    if (recordingState === "recording") stopRecording();
    recordingChunksRef.current = [];
    setAudioFile(null);
    setRecordingState("idle");
    setRecordingSeconds(0);
    recordingSecondsRef.current = 0;
    setStatus("");
  }

  async function loadTask(taskId: string) {
    setError("");
    setStatus("");
    const res = await fetch(`/api/diarize/tasks/${taskId}`);
    const data = await res.json();
    if (!res.ok) { setError(data.error || "读取任务失败"); return; }
    setActiveTask(data);
    setLogs(data.log || "");
  }

  async function retryTask(taskId: string) {
    setBusy(true);
    setError("");
    setStatus("");
    setLogs("");
    try {
      const res = await fetch(`/api/diarize/tasks/${taskId}/retry`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "重试失败");
      }
      await consumeTaskStream(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "重试失败");
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask(taskId: string) {
    const res = await fetch(`/api/diarize/tasks/${taskId}`, { method: "DELETE" });
    if (!res.ok) { setError("删除任务失败"); return; }
    setTasks((current) => current.filter((task) => task.id !== taskId));
    if (activeTask?.id === taskId) {
      setActiveTask(null);
      setLogs("");
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
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeTask.title.replace(/\.[^.]+$/, "") || "diarize"}_transcript.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function sendToInput() {
    if (!activeTask?.resultText) return;
    sessionStorage.setItem("chem-track:nl-input-draft", activeTask.resultText);
    router.push("/input");
  }

  function sendToFeedback() {
    if (!activeTask?.resultText) return;
    sessionStorage.setItem("chem-track:feedback-draft", activeTask.resultText);
    router.push("/feedback");
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">录音转写</h2>
        <p className="text-sm text-gray-500 mt-1">把课后回顾录音转成文字稿，再送入课后反馈工作台。</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-5">
        <div className="space-y-5">
          <div className="bg-white border border-gray-200 rounded-lg p-6 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">音频文件</span>
                <input
                  type="file"
                  accept="audio/*,.m4a,.mp3,.wav,.flac,.ogg,.opus"
                  onChange={(event) => {
                    setAudioFile(event.target.files?.[0] ?? null);
                    setRecordingState("idle");
                    setRecordingSeconds(0);
                    recordingSecondsRef.current = 0;
                  }}
                  className="mt-1 block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
                />
                {audioFile && (
                  <div className="mt-2 text-xs text-gray-500 truncate">当前：{audioFile.name}</div>
                )}
              </label>

              <div>
                <div className="text-sm font-medium text-gray-700">现场录音</div>
                <div className="mt-1 flex items-center gap-2">
                  {recordingState === "recording" ? (
                    <button
                      onClick={stopRecording}
                      type="button"
                      className="px-3 py-2 rounded-md bg-red-600 text-white text-sm font-medium"
                    >
                      停止录音
                    </button>
                  ) : (
                    <button
                      onClick={startRecording}
                      type="button"
                      disabled={busy}
                      className="px-3 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      开始录音
                    </button>
                  )}
                  {recordingState !== "idle" && (
                    <button
                      onClick={discardRecording}
                      type="button"
                      disabled={busy}
                      className="px-3 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      清除
                    </button>
                  )}
                </div>
                <div className={`mt-2 text-xs ${recordingState === "recording" ? "text-red-600" : "text-gray-500"}`}>
                  {recordingState === "recording"
                    ? `录音中 ${formatDuration(recordingSeconds)}`
                    : recordingState === "recorded"
                      ? `已录制 ${formatDuration(recordingSeconds)}`
                      : "可直接录制当前课堂音频"}
                </div>
              </div>
            </div>

            <div>
              <div className="text-sm font-medium text-gray-700 mb-2">转写方式</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {ENGINES.map((item) => (
                  <button
                    key={item.value}
                    onClick={() => setEngine(item.value)}
                    className={`rounded-md border px-3 py-2 text-left ${
                      engine === item.value ? "border-blue-300 bg-blue-50" : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <div className="text-sm font-medium text-gray-800">{item.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{item.note}</div>
                  </button>
                ))}
              </div>
            </div>

            {engine === "tingwu" && (
              <div className="rounded-md bg-amber-50 border border-amber-100 px-3 py-2 text-sm text-amber-800">
                听悟模式会调用阿里云并上传音频到 OSS。
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                onClick={startTask}
                disabled={busy || !audioFile}
                className="px-4 py-2 rounded-md bg-blue-600 text-white text-sm font-medium disabled:opacity-50"
              >
                {busy ? "处理中..." : "开始转写"}
              </button>
              {activeTask?.status === "failed" && (
                <button
                  onClick={() => retryTask(activeTask.id)}
                  disabled={busy}
                  className="px-4 py-2 rounded-md border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  重试
                </button>
              )}
            </div>

            {status && <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{status}</div>}
            {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>}
          </div>

          {activeTask && (
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
                <div>
                  <h3 className="font-semibold text-gray-800">{activeTask.title}</h3>
                  <div className="text-xs text-gray-500 mt-1">
                    {activeTask.engine} / 创建于 {formatTime(activeTask.createdAt)}
                  </div>
                </div>
                <span className={`rounded px-2 py-1 text-xs font-medium ${STATUS_CLASS[activeTask.status]}`}>
                  {STATUS_LABEL[activeTask.status]}
                </span>
              </div>

              {activeTask.error && (
                <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{activeTask.error}</div>
              )}

              {activeTask.resultText ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-3">
                    <button onClick={copyResult} className="px-3 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50">复制文字稿</button>
                    <button onClick={downloadResult} className="px-3 py-2 rounded-md border border-gray-300 text-sm text-gray-700 hover:bg-gray-50">下载 TXT</button>
                    <button onClick={sendToFeedback} className="px-3 py-2 rounded-md bg-amber-600 text-white text-sm font-medium">送入课后反馈</button>
                    <button onClick={sendToInput} className="px-3 py-2 rounded-md bg-blue-600 text-white text-sm font-medium">送入 NL 录入</button>
                  </div>
                  <textarea
                    readOnly
                    value={activeTask.resultText}
                    className="w-full h-80 border border-gray-200 rounded-md p-3 text-sm font-mono text-gray-800 bg-gray-50"
                  />
                </div>
              ) : (
                <div className="text-sm text-gray-500">任务完成后会在这里显示文字稿。</div>
              )}
            </div>
          )}

          <div className="bg-gray-950 rounded-lg p-4">
            <div className="mb-2 text-xs font-medium text-gray-300">运行日志</div>
            <pre className="h-56 overflow-auto whitespace-pre-wrap text-xs text-gray-100">{logs || "暂无日志"}</pre>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-4 h-fit">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-800">任务列表</h3>
            <button onClick={loadTasks} className="text-sm text-blue-600 hover:text-blue-700">刷新</button>
          </div>

          {tasks.length === 0 ? (
            <div className="text-sm text-gray-500">还没有转写任务。</div>
          ) : (
            <div className="space-y-2">
              {tasks.map((task) => (
                <div key={task.id} className="rounded-md border border-gray-200 p-3">
                  <button onClick={() => loadTask(task.id)} className="w-full text-left">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-gray-800 truncate">{task.title}</span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${STATUS_CLASS[task.status]}`}>
                        {STATUS_LABEL[task.status]}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-gray-500">{formatTime(task.createdAt)}</div>
                  </button>
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => loadTask(task.id)} className="text-xs text-blue-600 hover:text-blue-700">查看</button>
                    {task.status === "failed" && (
                      <button onClick={() => retryTask(task.id)} disabled={busy} className="text-xs text-gray-600 hover:text-gray-900 disabled:opacity-50">重试</button>
                    )}
                    <button onClick={() => deleteTask(task.id)} className="text-xs text-red-600 hover:text-red-700">删除</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
