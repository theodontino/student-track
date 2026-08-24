const lessonTopics = [
  "物质分类与转化",
  "离子反应",
  "氧化还原反应",
  "物质的量",
  "摩尔质量与气体摩尔体积",
  "阶段复习与综合应用",
] as const;

const lessonDates = [
  "2026-09-05",
  "2026-09-12",
  "2026-09-19",
  "2026-09-26",
  "2026-10-10",
  "2026-10-17",
] as const;

export const COURSE_CYCLE_FIXTURE = {
  semester: {
    id: "test-cycle-semester",
    name: "E2E完整课程周期",
    startDate: "2026-09-01",
    endDate: "2026-12-31",
  },
  classes: [
    { id: "test-cycle-class-a", semesterId: "test-cycle-semester", code: "TEST-CYCLE-A", name: "E2E课程一班" },
    { id: "test-cycle-class-b", semesterId: "test-cycle-semester", code: "TEST-CYCLE-B", name: "E2E课程二班" },
  ],
  students: [
    { id: "test-cycle-student-a1", name: "张三", studentId: "test-cycle-a-001", gender: "男", classIndex: 0 },
    { id: "test-cycle-student-a2", name: "李四", studentId: "test-cycle-a-002", gender: "女", classIndex: 0 },
    { id: "test-cycle-student-a3", name: "王五", studentId: "test-cycle-a-003", gender: "男", classIndex: 0 },
    { id: "test-cycle-student-b1", name: "赵六", studentId: "test-cycle-b-001", gender: "女", classIndex: 1 },
    { id: "test-cycle-student-b2", name: "孙七", studentId: "test-cycle-b-002", gender: "男", classIndex: 1 },
    { id: "test-cycle-student-b3", name: "周八", studentId: "test-cycle-b-003", gender: "女", classIndex: 1 },
  ],
  classGroup: {
    id: "test-cycle-class-group",
    name: "E2E完整课程班级组",
  },
  lessons: lessonTopics.map((topic, index) => ({
    id: `test-cycle-group-lesson-${index + 1}`,
    revisionId: `test-cycle-group-lesson-revision-${index + 1}`,
    sequence: index + 1,
    topic,
    date: lessonDates[index],
    sessions: [
      {
        id: `test-cycle-session-a-${index + 1}`,
        code: `2026${lessonDates[index].slice(5).replace("-", "")}01`,
        classIndex: 0,
        semesterNumber: index + 1,
      },
      {
        id: `test-cycle-session-b-${index + 1}`,
        code: `2026${lessonDates[index].slice(5).replace("-", "")}02`,
        classIndex: 1,
        semesterNumber: index + 1,
      },
    ],
  })),
  stageRange: { startLesson: 1, endLesson: 3 },
  dailyFeedbackLesson: 4,
  courseEndLesson: 6,
} as const;

export type CourseCycleStudent = (typeof COURSE_CYCLE_FIXTURE.students)[number];
