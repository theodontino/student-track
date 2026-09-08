import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { assertSafeTestDatabaseUrl } from "../scripts/test-environment";

const fixture = {
  semester: { id: "test-quick-fields-semester" },
  class: { id: "test-quick-fields-class", name: "合成逐维评分班" },
  students: [{ id: "test-quick-fields-student-a", name: "张三" }, { id: "test-quick-fields-student-b", name: "李四" }],
  sessions: [{ code: "test-quick-fields-session-a", date: "2098-01-01" }, { code: "test-quick-fields-session-b", date: "2098-01-08" }],
};

const student = fixture.students[0];
const context = { semesterId: fixture.semester.id, classId: fixture.class.id, className: fixture.class.name, sessionCode: fixture.sessions[0].code };
const url = () => `/quick-score?${new URLSearchParams({ semesterId: context.semesterId, classId: context.classId, class: context.className, sessionCode: context.sessionCode })}`;
const workspaceKey = () => `student-track:workspace:quick-score:${[context.semesterId, context.classId, context.className, ""].map(encodeURIComponent).join("|")}`;

async function resetScores(request: APIRequestContext) {
  for (const session of fixture.sessions) {
    const response = await request.post("/api/quick-score", { data: {
      sessionCode: session.code,
      scores: fixture.students.map((item) => ({ studentId: item.id, scoreA: 3, scoreB: 3, scoreC: 3 })),
      attendances: fixture.students.map((item) => ({ studentId: item.id, present: true })),
    } });
    expect(response.ok()).toBe(true);
  }
}

async function updateA(request: APIRequestContext, scoreA: number) {
  expect((await request.post("/api/quick-score", { data: { sessionCode: context.sessionCode, scores: [{ studentId: student.id, scoreA }] } })).ok()).toBe(true);
}

async function ready(page: Page) {
  await expect(page.getByRole("group", { name: "当前课次评分" })).toHaveAttribute("aria-busy", "false");
}

function card(page: Page) {
  return page.locator("article").filter({ has: page.getByText(student.name, { exact: true }) });
}

async function save(page: Page) {
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/quick-score") && response.request().method() === "POST");
  await page.getByRole("button", { name: "全部提交" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  await ready(page);
  await expect(page.getByText("没有未保存修改", { exact: true })).toBeVisible();
  return response.request().postDataJSON();
}

test.beforeAll(async ({ request }) => {
  assertSafeTestDatabaseUrl();
  const semester = await request.post("/api/semesters", { data: { name: "合成逐维评分学期", startDate: "2098-01-01", endDate: "2098-12-31" } });
  expect(semester.ok()).toBe(true);
  context.semesterId = fixture.semester.id = (await semester.json()).id;
  const classroom = await request.post(`/api/semesters/${context.semesterId}/classes`, { data: { code: "TEST-QUICK-FIELDS", name: context.className } });
  expect(classroom.ok()).toBe(true);
  context.classId = fixture.class.id = (await classroom.json()).id;
  for (const item of fixture.students) {
    const response = await request.post("/api/students", { data: { name: item.name, studentId: item.id, gender: "男", semesterId: context.semesterId, classId: context.classId } });
    expect(response.ok()).toBe(true);
    item.id = (await response.json()).id;
  }
  for (const session of fixture.sessions) {
    const response = await request.post(`/api/semesters/${context.semesterId}/session`, { data: { classId: context.classId, date: session.date, requestKey: crypto.randomUUID() } });
    expect(response.ok()).toBe(true);
    session.code = (await response.json()).code;
  }
  context.sessionCode = fixture.sessions[0].code;
});
test.beforeEach(async ({ request }) => { await resetScores(request); });
test.afterAll(async ({ request }) => {
  for (const item of fixture.students) expect((await request.delete(`/api/students/${item.id}`)).ok()).toBe(true);
  expect((await request.delete(`/api/semesters/${context.semesterId}`)).ok()).toBe(true);
});

test("preserves decimal A while editing and bulk-setting other dimensions, including an external A update", async ({ page, request }) => {
  await updateA(request, 4.2);
  await page.goto(url());
  await ready(page);
  await expect(page.getByLabel(`${student.name} A 当前分数`)).toHaveText("4.2");
  await card(page).getByText("纪律", { exact: true }).locator("..").getByRole("button", { name: "5", exact: true }).click();
  await page.locator(".quick-score-bulk").getByText("作业", { exact: true }).locator("..").getByRole("button", { name: "4", exact: true }).click();
  await card(page).getByRole("button", { name: "✓ 到" }).click();
  const payload = await save(page);
  expect(payload.scores).toEqual([
    { studentId: student.id, date: fixture.sessions[0].date, scoreB: 5, scoreC: 4 },
    { studentId: fixture.students[1].id, date: fixture.sessions[0].date, scoreC: 4 },
  ]);
  expect(payload.attendances).toEqual([{ studentId: student.id, present: false }]);
  await expect(page.getByLabel(`${student.name} A 当前分数`)).toHaveText("4.2");

  // The open page still shows 4.2 while another intake updates the database.
  await updateA(request, 4.6);
  await card(page).getByText("纪律", { exact: true }).locator("..").getByRole("button", { name: "4", exact: true }).click();
  expect((await save(page)).scores).toEqual([{ studentId: student.id, date: fixture.sessions[0].date, scoreB: 4 }]);
  await expect(page.getByLabel(`${student.name} A 当前分数`)).toHaveText("4.6");
  await card(page).getByText("学习", { exact: true }).locator("..").getByRole("button", { name: "4", exact: true }).click();
  expect((await save(page)).scores).toEqual([{ studentId: student.id, date: fixture.sessions[0].date, scoreA: 4 }]);
});

test("rebases an unsaved B edit on the latest A after leaving and returning", async ({ page, request }) => {
  await page.goto(url());
  await ready(page);
  await card(page).getByText("纪律", { exact: true }).locator("..").getByRole("button", { name: "5", exact: true }).click();
  await page.goto("/");
  await updateA(request, 4.2);
  await page.goto(url());
  await ready(page);
  await expect(page.getByLabel(`${student.name} A 当前分数`)).toHaveText("4.2");
  await expect(page.getByLabel(`${student.name} B 当前分数`)).toHaveText("5 · 已修改");
  expect((await save(page)).scores).toEqual([{ studentId: student.id, date: fixture.sessions[0].date, scoreB: 5 }]);
});

test("keeps legacy cards for explicit field recovery without silently restoring their old A", async ({ page, request }) => {
  await updateA(request, 4.2);
  await page.addInitScript(({ key, context, student }) => {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, JSON.stringify({ version: 1, savedAt: "2026-07-01T10:00:00.000Z", value: {
      context, date: "2098-01-01", cards: [{ studentId: student.id, studentName: student.name, scoreA: 3, scoreB: 5, scoreC: 3, present: true, note: "" }],
    } }));
  }, { key: workspaceKey(), context, student });
  await page.goto(url());
  await ready(page);
  await expect(page.getByLabel(`${student.name} A 当前分数`)).toHaveText("4.2");
  await expect(page.getByLabel(`${student.name} B 当前分数`)).toHaveText("3");
  await page.getByText("旧版草稿（未自动恢复）", { exact: true }).click();
  await page.getByRole("button", { name: `恢复${student.name}的B为5`, exact: true }).click();
  expect((await save(page)).scores).toEqual([{ studentId: student.id, date: fixture.sessions[0].date, scoreB: 5 }]);
  await page.reload();
  await ready(page);
  await expect(page.getByLabel(`${student.name} A 当前分数`)).toHaveText("4.2");
  await expect(page.getByText("旧版草稿（未自动恢复）", { exact: true })).toBeVisible();
});

test("blocks editing while a session loads and ignores its late response after switching back", async ({ page, request }) => {
  await updateA(request, 4.2);
  await page.goto(url());
  await ready(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let received!: () => void;
  const requested = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/quick-score?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("sessionCode") !== fixture.sessions[1].code) return route.continue();
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  await page.getByLabel("课次", { exact: true }).selectOption(fixture.sessions[1].code);
  await requested;
  await expect(card(page).getByRole("button", { name: "✓ 到" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "全部提交" })).toBeDisabled();
  await page.getByLabel("课次", { exact: true }).selectOption(context.sessionCode);
  await ready(page);
  const late = page.waitForResponse((response) => response.url().includes(`sessionCode=${fixture.sessions[1].code}`));
  release();
  await (await late).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByLabel("课次", { exact: true })).toHaveValue(context.sessionCode);
  await expect(page.getByLabel(`${student.name} A 当前分数`)).toHaveText("4.2");
});

test("keeps a failed load locked until retry and locks context controls while saving", async ({ page }) => {
  await page.goto(url());
  await ready(page);
  await page.getByLabel("学期", { exact: true }).selectOption(context.semesterId);
  await ready(page);
  await page.getByLabel("班级", { exact: true }).selectOption(context.classId);
  await ready(page);
  let failNext = true;
  await page.route("**/api/quick-score?**", async (route) => {
    if (failNext && new URL(route.request().url()).searchParams.get("sessionCode") === fixture.sessions[1].code) {
      failNext = false;
      return route.fulfill({ status: 500, json: { error: "合成加载失败" } });
    }
    return route.continue();
  });
  await page.getByLabel("课次", { exact: true }).selectOption(fixture.sessions[1].code);
  await expect(page.getByRole("button", { name: "重新加载评分" })).toBeVisible();
  await expect(card(page).getByRole("button", { name: "✓ 到" })).toBeDisabled();
  await page.getByRole("button", { name: "重新加载评分" }).click();
  await ready(page);
  await card(page).getByText("纪律", { exact: true }).locator("..").getByRole("button", { name: "5", exact: true }).click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/quick-score", async (route) => {
    await held;
    await route.continue();
  });
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/quick-score") && response.request().method() === "POST");
  await page.getByRole("button", { name: "全部提交" }).click();
  await expect(page.getByLabel("课次", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("班级", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("学期", { exact: true })).toBeDisabled();
  await expect(card(page).getByRole("button", { name: "✓ 到" })).toBeDisabled();
  release();
  expect((await saved).ok()).toBe(true);
  await ready(page);
});
