export const TEST_FIXTURE = {
  semester: {
    id: "test-semester-1",
    name: "E2E固定学期",
    startDate: "2026-01-01",
    endDate: "2099-12-31",
  },
  class: { id: "test-class-1", semesterId: "test-semester-1", code: "E2E-CLASS", name: "E2E测试班" },
  classTwo: { id: "test-class-2", semesterId: "test-semester-1", code: "E2E-CLASS-2", name: "E2E测试二班" },
  independentClass: { id: "test-class-3", semesterId: "test-semester-1", code: "E2E-CLASS-3", name: "E2E独立班" },
  sessions: [
    { id: "test-session-1", code: "2026070101", date: "2026-07-01", semesterNumber: 1 },
    { id: "test-session-2", code: "2026070801", date: "2026-07-08", semesterNumber: 2 },
  ],
  students: [
    { id: "test-student-1", name: "测试甲", studentId: "E2E-001", gender: "男" },
    { id: "test-student-2", name: "测试乙", studentId: "E2E-002", gender: "女" },
  ],
  groupStudents: [
    { id: "test-student-3", name: "测试丙", studentId: "E2E-003", gender: "男" },
    { id: "test-student-4", name: "测试丁", studentId: "E2E-004", gender: "女" },
  ],
  independentStudent: { id: "test-student-5", name: "测试戊", studentId: "E2E-005", gender: "女" },
  groupSession: { id: "test-session-3", code: "2026070802", date: "2026-07-08", semesterNumber: 1 },
  independentSession: { id: "test-session-4", code: "2026070803", date: "2026-07-08", semesterNumber: 2 },
  classGroup: { id: "test-class-group-1", name: "E2E共同班级组" },
  groupLesson: { id: "test-group-lesson-1", revisionId: "test-group-lesson-revision-1" },
  draft: { id: "test-draft-1", rawText: "E2E 草案：测试甲课堂表现积极" },
  feedbackHistory: { id: "test-feedback-history-1", title: "E2E 历史反馈" },
} as const;
