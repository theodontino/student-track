"use client";

import { useParams, useRouter } from "next/navigation";
import { Badge, Button, EmptyState, ErrorState, LoadingState, StatusBanner } from "@/components/ui";
import { SemesterContextSelector } from "@/features/teaching-context/SemesterContextSelector";
import { StudentPerformanceOverview } from "./StudentPerformanceOverview";
import { StudentRecords } from "./StudentRecords";
import { StudentTrendChart } from "./StudentTrendChart";
import { StudentTeachingMemory } from "./StudentTeachingMemory";
import CommunicationPreferencePanel from "./CommunicationPreferencePanel";
import { useStudentDetailWorkspace } from "./useStudentDetailWorkspace";

export default function StudentDetailWorkspace() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const workspace = useStudentDetailWorkspace(id);
  const {
    student, hydrated, loading, loadError, selectedSemesterId, setSemesterId, fetchStudent,
  } = workspace;

  if (!hydrated || (loading && !student)) return <LoadingState label="正在加载学生档案…" />;
  if (loadError && !student) return <ErrorState message={loadError} action={<Button onClick={() => void fetchStudent()}>重试</Button>} />;
  if (!student) return (
    <EmptyState title="学生不存在" description="这名学生可能已被移除，或当前链接已经失效。" action={<Button variant="secondary" onClick={() => router.push("/students")}>返回学生列表</Button>} />
  );

  const summary = student.semesterSummary;
  const totalSessions = summary?.attendanceRecordedCount ?? student.attendances.length;
  const presentCount = summary?.presentCount ?? student.attendances.filter((attendance) => attendance.present).length;
  function changeSemester(semesterId: string) {
    setSemesterId(semesterId);
  }
  function returnToStudentList() {
    const path = `/students${selectedSemesterId ? `?semesterId=${encodeURIComponent(selectedSemesterId)}` : ""}`;
    // Context changes use the native history API to avoid remounting a page
    // with unsaved edits. Navigate the destination directly so a stale App
    // Router transition cannot replace the selected semester.
    window.location.assign(path);
  }

  return (
    <main className="student-detail-workspace">
      <div className="student-detail-toolbar">
        <Button variant="ghost" uiSize="sm" onClick={returnToStudentList}>← 返回学生列表</Button>
        <SemesterContextSelector value={selectedSemesterId} onChange={changeSemester} compact />
      </div>

      {loadError && <StatusBanner tone="danger"><span>{loadError}</span><Button variant="secondary" uiSize="sm" onClick={() => void fetchStudent()}>重试</Button></StatusBanner>}

      <header className="student-profile-header">
        <div className={`student-profile-header__avatar ${student.gender === "男" ? "is-male" : "is-female"}`} aria-hidden="true">{student.name[0]}</div>
        <div className="student-profile-header__identity">
          <p>学生档案</p>
          <h1>{student.name}</h1>
          <span>{student.class || "未加入本学期班级"} · {student.studentId}</span>
        </div>
        <div className="student-profile-header__meta">
          <div>{!student.rosterStatus && <Badge>未加入本学期名单</Badge>}{student.rosterStatus === "INACTIVE" && <Badge tone="warning">非活跃</Badge>}{student.labels.length ? student.labels.map((label) => <Badge key={label.id}>{label.name}</Badge>) : <span>暂无标签</span>}</div>
          <p>{student.statusEffectiveAt ? `花名册状态生效：${new Date(student.statusEffectiveAt).toLocaleString("zh-CN")}` : "本学期暂无花名册归属"}</p>
          <p>{summary?.semester.name ?? "暂无学期"} · 出勤 {presentCount}/{totalSessions} · D={summary?.attendanceScore ?? "—"}</p>
        </div>
      </header>

      <StudentPerformanceOverview summary={summary} />
      <StudentTrendChart metrics={student.sessionMetrics} />
      <StudentTeachingMemory studentId={student.id} semesterId={selectedSemesterId || undefined} />
      <CommunicationPreferencePanel studentId={student.id} />
      <StudentRecords
        student={student}
        activePanel={workspace.activePanel}
        setActivePanel={workspace.setActivePanel}
        eventHasMore={workspace.eventHasMore}
        commHasMore={workspace.commHasMore}
        loadingMore={workspace.loadingMore}
        recordsError={workspace.recordsError}
        loadMoreEvents={workspace.loadMoreEvents}
        loadMoreCommunications={workspace.loadMoreCommunications}
      />
    </main>
  );
}
