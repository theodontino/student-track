export const TEST_FIXTURE = {
  class: { id: "test-class-1", code: "E2E-CLASS", name: "E2E测试班" },
  semester: {
    id: "test-semester-1",
    name: "E2E固定学期",
    startDate: "2026-01-01",
    endDate: "2099-12-31",
  },
  sessions: [
    { id: "test-session-1", code: "2026070101", date: "2026-07-01", semesterNumber: 1 },
    { id: "test-session-2", code: "2026070801", date: "2026-07-08", semesterNumber: 2 },
  ],
  students: [
    { id: "test-student-1", name: "测试甲", studentId: "E2E-001", gender: "男" },
    { id: "test-student-2", name: "测试乙", studentId: "E2E-002", gender: "女" },
  ],
  draft: { id: "test-draft-1", rawText: "E2E 草案：测试甲课堂表现积极" },
  feedbackHistory: { id: "test-feedback-history-1", title: "E2E 历史反馈" },
} as const;
