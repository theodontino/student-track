"use client";

import { Badge, Button, EmptyState, Select, StatusBanner } from "@/components/ui";
import { DIM_LABEL } from "@/lib/constants";
import type { DraftReviewResult, DraftStudent, DraftStructuredResult, ScoreDimension } from "@/lib/types";

const DIMENSIONS: ScoreDimension[] = ["A", "B", "C"];

export function AttendanceEditor({ value, onChange, disabled = false }: { value: boolean | undefined; onChange?: (present: boolean) => void; disabled?: boolean }) {
  if (typeof value !== "boolean") return null;
  if (!onChange) return <Badge tone={value ? "success" : "danger"}>{value ? "出勤" : "缺勤"}</Badge>;
  return (
    <div className="entry-attendance" role="group" aria-label="考勤状态">
      <button type="button" disabled={disabled} aria-pressed={value} onClick={() => onChange(true)}>出勤</button>
      <button type="button" disabled={disabled} aria-pressed={!value} onClick={() => onChange(false)}>缺勤</button>
    </div>
  );
}

export function MetricEditor({ dimension, value, suggested, onChange }: { dimension: ScoreDimension; value: number | null; suggested?: number | null; onChange?: (value: number | null) => void }) {
  if (!onChange) {
    return <div className="entry-metric"><span>{DIM_LABEL[dimension]}</span><strong>{value ?? "—"}</strong></div>;
  }
  return (
    <label className={suggested != null ? "entry-metric-editor is-suggested" : "entry-metric-editor"}>
      <span>{DIM_LABEL[dimension]}{suggested != null ? ` · 建议 ${suggested}` : ""}</span>
      <Select value={value ?? ""} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}>
        <option value="">未提及</option>
        {[0, 1, 2, 3, 4, 5].map((score) => <option key={score} value={score}>{score} 分</option>)}
      </Select>
    </label>
  );
}

export function ReviewSummary({ review }: { review: DraftReviewResult | null }) {
  if (!review) return <StatusBanner tone="info">当前草案没有自审结果，请人工核对后再确认。</StatusBanner>;
  if (review.is_valid && review.issues.length === 0 && review.suggestions.length === 0) {
    return <StatusBanner tone="success">自审未发现明显问题，仍请核对考勤与评分。</StatusBanner>;
  }
  return (
    <div className="entry-review-summary">
      <strong>{review.is_valid ? "自审通过" : `自审发现 ${review.issues.length} 个问题`}</strong>
      {review.issues.length > 0 && <ul>{review.issues.map((issue, index) => <li key={`issue-${index}`}>{issue}</li>)}</ul>}
      {review.suggestions.length > 0 && <ul>{review.suggestions.map((suggestion, index) => <li key={`suggestion-${index}`}>建议：{suggestion}</li>)}</ul>}
    </div>
  );
}

interface DraftStudentCardProps {
  student: DraftStudent;
  review?: { revisedScores?: Record<string, number | null>; revisedEvents?: string[] } | null;
  onAttendanceChange?: (present: boolean) => void;
  onScoreChange?: (dimension: ScoreDimension, value: number | null) => void;
  onRemoveEvent?: (index: number) => void;
}

export function DraftStudentCard({ student, review, onAttendanceChange, onScoreChange, onRemoveEvent }: DraftStudentCardProps) {
  const editable = Boolean(onAttendanceChange || onScoreChange || onRemoveEvent);
  return (
    <article className={`entry-draft-student ${review ? "has-review" : ""}`}>
      <header>
        <div><strong>{student.name}</strong>{review && <Badge tone="warning">需关注</Badge>}</div>
        <AttendanceEditor value={student.present} onChange={onAttendanceChange} />
      </header>
      {review && <div className="entry-student-suggestion">
        {review.revisedScores && Object.entries(review.revisedScores).filter(([, value]) => value != null).map(([dimension, value]) => <span key={dimension}>{DIM_LABEL[dimension] ?? dimension}建议 {value} 分</span>)}
        {review.revisedEvents?.length ? <span>建议事件：{review.revisedEvents.join("、")}</span> : null}
      </div>}
      <div className="entry-metrics">
        {DIMENSIONS.map((dimension) => <MetricEditor key={dimension} dimension={dimension} value={student.scores[dimension]} suggested={review?.revisedScores?.[dimension]} onChange={onScoreChange ? (value) => onScoreChange(dimension, value) : undefined} />)}
      </div>
      {student.events.length > 0 && <div className="entry-events"><span>事件</span><div>{student.events.map((event, index) => <Badge key={`${event}-${index}`} tone="info">{event}{editable && onRemoveEvent ? <button type="button" aria-label={`删除事件 ${event}`} onClick={() => onRemoveEvent(index)}>×</button> : null}</Badge>)}</div></div>}
      {student.communication && <div className="entry-communication"><strong>家校沟通 · {student.communication.type}</strong><p>{student.communication.summary}</p></div>}
    </article>
  );
}

export function ParseResultPreview({ result }: { result: DraftStructuredResult }) {
  return (
    <div className="entry-draft-list">
      {result.students.length > 0 ? result.students.map((student, index) => <DraftStudentCard key={`${student.name}-${index}`} student={student} />) : <EmptyState title="没有解析到学生记录" />}
      {result.alert_suggestion && <StatusBanner tone="danger"><strong>关注建议：</strong>{result.alert_suggestion}</StatusBanner>}
    </div>
  );
}

export function DraftReviewEditor({ result, review, processing, onScoreChange, onAttendanceChange, onRemoveEvent, onReject, onConfirm }: {
  result: DraftStructuredResult;
  review: DraftReviewResult | null;
  processing: boolean;
  onScoreChange: (studentIndex: number, dimension: ScoreDimension, value: number | null) => void;
  onAttendanceChange: (studentIndex: number, present: boolean) => void;
  onRemoveEvent: (studentIndex: number, eventIndex: number) => void;
  onReject: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="entry-review-editor">
      <ReviewSummary review={review} />
      {result.students.map((student, studentIndex) => {
        const revisedScores = review?.revised_scores?.[student.name];
        const revisedEvents = review?.revised_events?.[student.name];
        const suggestion = revisedScores || revisedEvents ? { revisedScores, revisedEvents } : null;
        return <DraftStudentCard key={`${student.name}-${studentIndex}`} student={student} review={suggestion} onAttendanceChange={(present) => onAttendanceChange(studentIndex, present)} onScoreChange={(dimension, value) => onScoreChange(studentIndex, dimension, value)} onRemoveEvent={(eventIndex) => onRemoveEvent(studentIndex, eventIndex)} />;
      })}
      {result.alert_suggestion && <StatusBanner tone="danger"><strong>关注建议：</strong>{result.alert_suggestion}</StatusBanner>}
      <div className="entry-review-actions">
        <Button variant="secondary" disabled={processing} onClick={onReject}>{processing ? "处理中…" : "✕ 放弃"}</Button>
        <Button disabled={processing} onClick={onConfirm}>{processing ? "处理中…" : "✓ 确认写入"}</Button>
      </div>
    </div>
  );
}
