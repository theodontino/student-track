"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, Input, Select, StatusBanner } from "@/components/ui";
import type { GroupProgressIntent, SessionCreationOptions } from "@/lib/contracts/session-creation";
import { requestJson } from "@/lib/api-client";
import type { SessionSummary } from "@/features/teaching-context/types";

export interface SessionDialogClass {
  id: string;
  code: string;
  name: string | null;
}

export interface SessionDialogProps {
  open: boolean;
  semesterId: string;
  classId?: string;
  className?: string;
  classes?: SessionDialogClass[];
  initialDate?: string;
  onClose: () => void;
  onSaved: (session: SessionSummary) => void | Promise<void>;
}

type IntentType = GroupProgressIntent["type"] | "";

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function displayClass(klass: SessionDialogClass | null | undefined) {
  return klass?.name ?? klass?.code ?? "请先选择班级";
}

function recommendationCanRun(options: SessionCreationOptions | null) {
  return options?.recommendation.type === "existing" || options?.recommendation.type === "new";
}

export function SessionDialog({
  open,
  semesterId,
  classId = "",
  className = "",
  classes,
  initialDate,
  onClose,
  onSaved,
}: SessionDialogProps) {
  const [date, setDate] = useState(initialDate ?? today());
  const [selectedClassId, setSelectedClassId] = useState(classId || classes?.[0]?.id || "");
  const [creationOptions, setCreationOptions] = useState<SessionCreationOptions | null>(null);
  const [intentType, setIntentType] = useState<IntentType>("");
  const [lessonId, setLessonId] = useState("");
  const [intentChoicesExpanded, setIntentChoicesExpanded] = useState(false);
  const [error, setError] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsRequestVersion, setOptionsRequestVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [sameDayCount, setSameDayCount] = useState<number | null>(null);
  const submissionRef = useRef<{ payload: string; requestKey: string } | null>(null);

  const selectedClass = useMemo(
    () => classes?.find((klass) => klass.id === selectedClassId) ?? null,
    [classes, selectedClassId],
  );
  const effectiveClassName = selectedClass ? displayClass(selectedClass) : className;

  useEffect(() => {
    if (!open) return;
    setDate(initialDate ?? today());
    setError("");
    submissionRef.current = null;
  }, [initialDate, open]);

  useEffect(() => {
    if (!open) return;
    setSelectedClassId((current) => {
      if (classId) return classId;
      if (current && classes?.some((klass) => klass.id === current)) return current;
      return classes?.[0]?.id ?? "";
    });
  }, [classId, classes, open]);

  useEffect(() => {
    if (!open || !semesterId || !selectedClassId || !date) {
      setCreationOptions(null);
      setLoadingOptions(false);
      return;
    }
    const controller = new AbortController();
    setLoadingOptions(true);
    setError("");
    setOptionsError("");
    setCreationOptions(null);
    setIntentType("");
    setLessonId("");
    setIntentChoicesExpanded(false);
    const params = new URLSearchParams({ classId: selectedClassId, date });
    void requestJson<SessionCreationOptions>(`/api/semesters/${encodeURIComponent(semesterId)}/session?${params.toString()}`, { signal: controller.signal })
      .then((options) => {
        setCreationOptions(options);
        if (options.recommendation.type === "existing" || options.recommendation.type === "new") {
          setIntentType("recommended");
        } else if (options.recommendation.type === "independent") {
          setIntentType("independent");
        }
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setOptionsError(reason instanceof Error ? reason.message : "读取共同进度选项失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingOptions(false);
      });
    return () => controller.abort();
  }, [date, open, optionsRequestVersion, selectedClassId, semesterId]);

  useEffect(() => {
    if (!open || !semesterId || !selectedClassId || !date) {
      setSameDayCount(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ semesterId, classId: selectedClassId, date });
    void requestJson<unknown[]>(`/api/sessions?${params.toString()}`)
      .then((sessions) => {
        if (!cancelled) setSameDayCount(Array.isArray(sessions) ? sessions.length : 0);
      })
      .catch(() => {
        if (!cancelled) setSameDayCount(null);
      });
    return () => { cancelled = true; };
  }, [date, open, selectedClassId, semesterId]);

  function chooseLesson(nextLessonId: string) {
    setIntentType("lesson");
    setLessonId(nextLessonId);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedClassId || !intentType) return;
    const groupProgressIntent: GroupProgressIntent = intentType === "lesson"
      ? { type: "lesson", groupLessonId: lessonId }
      : { type: intentType };
    const requestPayload = { classId: selectedClassId, date, groupProgressIntent };
    const serializedPayload = JSON.stringify(requestPayload);
    const requestKey = submissionRef.current?.payload === serializedPayload
      ? submissionRef.current.requestKey
      : crypto.randomUUID();
    submissionRef.current = { payload: serializedPayload, requestKey };
    setSaving(true);
    setError("");
    try {
      const session = await requestJson<SessionSummary>(`/api/semesters/${encodeURIComponent(semesterId)}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...requestPayload, requestKey }),
      });
      submissionRef.current = null;
      await onSaved(session);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建课次失败");
    } finally {
      setSaving(false);
    }
  }

  const recommendation = creationOptions?.recommendation ?? null;
  const showExplicitChoiceWarning = recommendation?.type === "choice_required" || recommendation?.type === "waiting";
  const showIntentChoices = Boolean(creationOptions?.group) && (showExplicitChoiceWarning || intentChoicesExpanded);
  const recommendedProgressSummary = recommendation?.type === "existing"
    ? `将作为共同第 ${recommendation.lesson.sequence} 讲${recommendation.lesson.title === `第 ${recommendation.lesson.sequence} 讲` ? "" : ` · ${recommendation.lesson.title}`}`
    : recommendation?.type === "new"
      ? `将新建并关联共同第 ${recommendation.nextSequence} 讲`
      : "";

  return (
    <Dialog open={open} title="新建真实课次" onClose={() => { if (!saving) onClose(); }}>
      <form onSubmit={submit} className="dialog-form session-create-form">
        {error && <StatusBanner tone="danger">{error}</StatusBanner>}
        {sameDayCount !== null && sameDayCount > 0 && (
          <StatusBanner tone="warning">本班级 {date} 当天已有 {sameDayCount} 节课，仍可另建一条真实课次。</StatusBanner>
        )}

        {classes ? (
          <label>班级<Select required value={selectedClassId} onChange={(event) => setSelectedClassId(event.target.value)}>{classes.map((klass) => <option key={klass.id} value={klass.id}>{displayClass(klass)}</option>)}</Select></label>
        ) : <p className="dialog-form__hint">{effectiveClassName || "请先选择班级"}</p>}
        <label>上课日期<Input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>

        {loadingOptions && <p className="session-intent-picker__status" role="status">正在核对建课设置…</p>}
        {optionsError && <StatusBanner tone="danger"><span>{optionsError}</span><Button variant="ghost" uiSize="sm" onClick={() => setOptionsRequestVersion((value) => value + 1)}>重试</Button></StatusBanner>}

        {creationOptions?.group && <fieldset className="session-intent-picker">
          <legend>共同进度</legend>
          {!showIntentChoices && <StatusBanner tone="info">
            <span>{creationOptions.group.name} · {recommendedProgressSummary}</span>
            <Button variant="ghost" uiSize="sm" onClick={() => setIntentChoicesExpanded(true)}>更改</Button>
          </StatusBanner>}

          {showIntentChoices && <>
            <p className="session-intent-picker__context">{creationOptions.group.name} · {creationOptions.group.isLeadClass ? "进度基准班" : `进度基准班 ${displayClass(creationOptions.group.leadClass)}`}</p>
            {showExplicitChoiceWarning && <StatusBanner tone="warning">{recommendation.reason}</StatusBanner>}

            {recommendationCanRun(creationOptions) && <label className={`session-intent-option${intentType === "recommended" ? " is-selected" : ""}`}>
              <input type="radio" name="group-progress-intent" checked={intentType === "recommended"} onChange={() => { setIntentType("recommended"); setLessonId(""); }} />
              <span><strong>采用系统建议 <small>推荐</small></strong><span>{recommendation?.reason}</span></span>
            </label>}

            <label className={`session-intent-option${intentType === "independent" ? " is-selected" : ""}`}>
              <input type="radio" name="group-progress-intent" checked={intentType === "independent"} onChange={() => { setIntentType("independent"); setLessonId(""); }} />
              <span><strong>建立独立课次</strong><span>{recommendation?.type === "independent" ? recommendation.reason : "适合补课、临时课或暂不进入共同进度的课。之后仍可手动关联。"}</span></span>
            </label>

            {creationOptions.lessons.length > 0 && <div className={`session-intent-option session-intent-option--lesson${intentType === "lesson" ? " is-selected" : ""}`}>
              <label><input type="radio" name="group-progress-intent" checked={intentType === "lesson"} onChange={() => chooseLesson(lessonId || creationOptions.lessons[0].id)} /><span><strong>指定已建立的共同讲次</strong><span>用于回填、补课或系统无法安全判断时。</span></span></label>
              <Select aria-label="指定共同讲次" value={lessonId} onChange={(event) => chooseLesson(event.target.value)} onFocus={() => { if (!lessonId) chooseLesson(creationOptions.lessons[0].id); }}>
                <option value="">请选择共同讲次</option>
                {creationOptions.lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>第 {lesson.sequence} 讲 · {lesson.title}{lesson.started ? " · 已有其他班开始" : " · 尚未开始"}</option>)}
              </Select>
            </div>}
          </>}
        </fieldset>}

        {creationOptions?.group && <p className="dialog-form__hint">共同进度只建立关联，不会移动或合并本课的评分、考勤和事件。</p>}
        <div className="dialog-form__actions">
          <Button variant="secondary" onClick={onClose} disabled={saving}>取消</Button>
          <Button type="submit" disabled={saving || loadingOptions || Boolean(optionsError) || !selectedClassId || !intentType || (intentType === "lesson" && !lessonId)}>{saving ? "创建中…" : "创建课次"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
