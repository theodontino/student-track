import { expect, test } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

const observation = {
  id: "e2e-observation-1",
  kind: "classroom-alignment",
  topic: "parent-concern",
  title: "家长关切与课堂表现一致",
  evidenceSummary: "家长关切和本次课堂记录指向同一学习环节。",
  status: "new",
  analysisVersion: "e2e-v1",
  firstDetectedAt: "2026-07-01T08:00:00.000Z",
  lastDetectedAt: "2026-07-01T08:00:00.000Z",
  statusChangedAt: "2026-07-01T08:00:00.000Z",
  student: {
    id: TEST_FIXTURE.students[0].id,
    name: TEST_FIXTURE.students[0].name,
    studentId: TEST_FIXTURE.students[0].studentId,
    classId: TEST_FIXTURE.class.id,
    className: TEST_FIXTURE.class.name,
    href: `/students/${TEST_FIXTURE.students[0].id}`,
  },
  sources: [{
    communicationId: "e2e-communication-1",
    target: "母亲",
    summary: "家长关注知识点是否真正理解。",
    occurredAt: "2026-07-01T08:00:00.000Z",
    sessionCode: TEST_FIXTURE.sessions[0].code,
    sessionDate: TEST_FIXTURE.sessions[0].date,
    relatedSessionCode: TEST_FIXTURE.sessions[0].code,
    studentHref: `/students/${TEST_FIXTURE.students[0].id}?semesterId=${TEST_FIXTURE.semester.id}`,
    sessionHref: `/quick-score?semesterId=${TEST_FIXTURE.semester.id}&sessionCode=${TEST_FIXTURE.sessions[0].code}`,
  }],
};

function bundle(scope: "session" | "date", status = observation.status) {
  return {
    facts: {
      scope: scope === "session"
        ? { type: "session", sessionCode: TEST_FIXTURE.sessions[0].code }
        : { type: "date", semesterId: TEST_FIXTURE.semester.id, date: TEST_FIXTURE.sessions[0].date },
      scopeKey: scope === "session" ? TEST_FIXTURE.sessions[0].code : `${TEST_FIXTURE.semester.id}:${TEST_FIXTURE.sessions[0].date}`,
      semester: TEST_FIXTURE.semester,
      date: TEST_FIXTURE.sessions[0].date,
      totals: {
        sessionCount: 1, classCount: 1, coveredStudentCount: 2, metricRecordedCount: 2,
        attendanceRecordedCount: 2, presentCount: 2, absentCount: 0, eventCount: 1,
        pendingDraftCount: 0, missingFeedbackHistoryCount: 0, communicationCount: 1,
        communicationInputTruncated: false,
      },
      sessions: [{
        id: TEST_FIXTURE.sessions[0].id, code: TEST_FIXTURE.sessions[0].code,
        date: TEST_FIXTURE.sessions[0].date, semesterNumber: 1, classId: TEST_FIXTURE.class.id,
        className: TEST_FIXTURE.class.name, studentCount: 2, metricRecordedCount: 2,
        attendanceRecordedCount: 2, presentCount: 2, absentCount: 0, eventCount: 1,
        communicationCount: 1, averages: { A: 4, B: 4, C: 3.5, D: 5 },
        pendingDraftCount: 0, feedbackHistoryFound: true,
        href: `/quick-score?semesterId=${TEST_FIXTURE.semester.id}&sessionCode=${TEST_FIXTURE.sessions[0].code}`,
      }],
      students: [],
      pendingItems: [],
    },
    analysis: {
      overview: "课堂事实完整，家长关切与课堂证据可以相互核对。",
      classComparisons: [],
      noteworthyChanges: [],
      suggestedActions: [],
    },
    observations: [{ ...observation, status }],
    cache: { status: "hit", generatedAt: "2026-07-01T09:00:00.000Z" },
  };
}

test("v0.21 teaching summary keeps facts, AI and observations separate", async ({ page }) => {
  let observationStatus = observation.status;
  let generationBody: Record<string, unknown> | null = null;
  await page.route("**/api/report/teaching-summary**", async (route) => {
    if (route.request().method() === "POST") generationBody = route.request().postDataJSON();
    const requestedScope = route.request().method() === "POST"
      ? ((generationBody?.scope as { type?: string } | undefined)?.type === "date" ? "date" : "session")
      : new URL(route.request().url()).searchParams.get("scope") === "date" ? "date" : "session";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bundle(requestedScope, observationStatus)) });
  });
  await page.route("**/api/teacher-observations**", async (route) => {
    if (route.request().method() === "PATCH") {
      observationStatus = (route.request().postDataJSON() as { status: typeof observationStatus }).status;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...observation, status: observationStatus }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ ...observation, status: observationStatus }]) });
  });

  await page.goto("/daily-report");
  await page.getByLabel("学期").selectOption(TEST_FIXTURE.semester.id);
  await page.getByLabel("班级").selectOption({ label: TEST_FIXTURE.class.name });
  await page.getByLabel("课次").selectOption(TEST_FIXTURE.sessions[0].code);
  await expect(page.getByRole("heading", { name: "确定性待办" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI 教师解读" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "家校沟通观察" })).toBeVisible();

  await page.getByLabel("教学总结范围").getByRole("button", { name: "按日期" }).click();
  await page.getByLabel("学期").selectOption(TEST_FIXTURE.semester.id);
  await page.getByLabel("日期").fill(TEST_FIXTURE.sessions[0].date);
  await expect(page.getByText(TEST_FIXTURE.class.name).first()).toBeVisible();

  await page.getByRole("checkbox", { name: "纳入已确认家校沟通" }).uncheck();
  await page.getByRole("button", { name: "使用当前缓存" }).click();
  await expect.poll(() => generationBody?.includeCommunications).toBe(false);

  await page.getByRole("button", { name: "已阅" }).click();
  expect(observationStatus).toBe("read");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "家校沟通观察" })).toBeVisible();
  await expect(page.getByText("家长关切与课堂表现一致")).toBeVisible();

  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/daily-report");
  await expect(page.getByRole("heading", { name: "教学总结" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
