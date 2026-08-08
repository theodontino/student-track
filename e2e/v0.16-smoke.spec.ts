import { expect, test, type Page } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

async function blockExternalRequests(page: Page) {
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const isHttp = url.protocol === "http:" || url.protocol === "https:";
    const isLocal = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (isHttp && !isLocal) {
      blocked.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return blocked;
}

async function selectQuickScoreClass(page: Page) {
  const semesterSelect = page.getByLabel("学期", { exact: true });
  await expect(semesterSelect).toBeEnabled();
  if (await semesterSelect.inputValue() !== TEST_FIXTURE.semester.id) {
    await semesterSelect.selectOption(TEST_FIXTURE.semester.id);
  }
  const classSelect = page.getByLabel("班级", { exact: true });
  await expect(classSelect).toBeEnabled();
  if (await classSelect.inputValue() !== TEST_FIXTURE.class.id) {
    await classSelect.selectOption({ label: TEST_FIXTURE.class.name });
  }
  await expect(page.getByText(TEST_FIXTURE.students[0].name, { exact: true })).toBeVisible();
  await expect(page.getByLabel("课次", { exact: true })).toBeVisible();
}

test.describe.serial("v0.16.0 core browser smoke tests", () => {
  test("quick score saves attendance and scores, then reloads them", async ({ page }) => {
    const externalRequests = await blockExternalRequests(page);
    await page.goto("/quick-score");
    await expect(page.getByRole("heading", { name: "手动评分" })).toBeVisible();
    await selectQuickScoreClass(page);
    await page.getByLabel("课次", { exact: true }).selectOption(TEST_FIXTURE.sessions[0].code);

    const studentCard = page.getByText(TEST_FIXTURE.students[0].name, { exact: true }).locator("..").locator("..");
    await studentCard.getByRole("button", { name: "✓ 到" }).click();
    await studentCard.getByText("学习", { exact: true }).locator("..").getByRole("button", { name: "5", exact: true }).click();
    const saveResponsePromise = page.waitForResponse((response) => {
      const request = response.request();
      return new URL(response.url()).pathname === "/api/quick-score" && request.method() === "POST";
    });
    await page.getByRole("button", { name: "全部提交" }).click();
    const saveResponse = await saveResponsePromise;
    expect(saveResponse.ok()).toBe(true);
    await expect(page.getByText("没有未保存修改", { exact: true })).toBeVisible();

    await page.reload();
    await selectQuickScoreClass(page);
    await page.getByLabel("课次", { exact: true }).selectOption(TEST_FIXTURE.sessions[0].code);
    const reloadedCard = page.getByText(TEST_FIXTURE.students[0].name, { exact: true }).locator("..").locator("..");
    await expect(reloadedCard.getByRole("button", { name: "✕ 缺" })).toBeVisible();
    await expect(
      reloadedCard.getByText("学习", { exact: true }).locator("..").getByRole("button", { name: "5", exact: true }),
    ).toHaveClass(/scale-110/);
    expect(externalRequests).toEqual([]);
  });

  test("pending draft confirmation writes the formal session record", async ({ page }) => {
    const externalRequests = await blockExternalRequests(page);
    await page.goto("/review");
    await expect(page.getByRole("heading", { name: "复核中心" })).toBeVisible();
    await page.getByText(TEST_FIXTURE.draft.rawText, { exact: true }).click();
    await page.getByRole("button", { name: "✓ 确认写入" }).click();
    await expect(page.getByText(TEST_FIXTURE.draft.rawText, { exact: true })).toHaveCount(0);

    const confirmedResponse = await page.request.get("/api/review?status=confirmed");
    expect(confirmedResponse.ok()).toBe(true);
    const confirmedDrafts = await confirmedResponse.json();
    expect(confirmedDrafts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: TEST_FIXTURE.draft.id, status: "confirmed" }),
    ]));

    const params = new URLSearchParams({
      class: TEST_FIXTURE.class.name,
      sessionCode: TEST_FIXTURE.sessions[1].code,
    });
    const scoreResponse = await page.request.get(`/api/quick-score?${params.toString()}`);
    expect(scoreResponse.ok()).toBe(true);
    const scoreData = await scoreResponse.json();
    expect(scoreData.scores).toEqual(expect.arrayContaining([
      expect.objectContaining({
        studentId: TEST_FIXTURE.students[0].id,
        scoreA: 5,
        scoreB: 4,
        scoreC: 3,
        present: true,
      }),
    ]));
    expect(externalRequests).toEqual([]);
  });

  test("feedback history reads FeedbackPlan and restores with plan context", async ({ page }) => {
    const externalRequests = await blockExternalRequests(page);
    await page.route("**/api/report/feedback-plans**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({ json: { plans: [{
        id: "e2e-plan-history",
        type: "event_micro",
        status: "needs_review",
        archivedAt: null,
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T09:00:00.000Z",
        outputRequirement: "历史筛选测试",
        session: { id: TEST_FIXTURE.sessions[0].id, code: TEST_FIXTURE.sessions[0].code, date: TEST_FIXTURE.sessions[0].date, semesterNumber: 1 },
        rangeEndSession: null,
        class: { id: TEST_FIXTURE.class.id, code: TEST_FIXTURE.class.code, name: TEST_FIXTURE.class.name },
        semester: { id: TEST_FIXTURE.semester.id, name: TEST_FIXTURE.semester.name },
        studentSummaries: [{ id: TEST_FIXTURE.students[0].id, name: TEST_FIXTURE.students[0].name, studentId: TEST_FIXTURE.students[0].studentId }],
        itemStatusCounts: { total: 1, queued: 0, running: 0, completed: 0, failed: 0, stale: 0 },
      }] } });
    });
    await page.goto(`/history?semesterId=${TEST_FIXTURE.semester.id}`);
    await expect(page.getByRole("heading", { name: "反馈历史" })).toBeVisible();
    await expect(page.getByText("历史筛选测试", { exact: true })).toBeVisible();
    await expect(page.getByText(`学生：${TEST_FIXTURE.students[0].name}`, { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "恢复" }).click();
    await expect(page).toHaveURL(/\/feedback\?.*step=review.*planId=e2e-plan-history/);
    expect(externalRequests).toEqual([]);
  });

  test("feedback workbench exposes the plan flow without legacy batch controls", async ({ page }) => {
    const externalRequests = await blockExternalRequests(page);
    await page.goto("/feedback?step=review");
    await expect(page.getByRole("heading", { name: "复核与反馈计划" })).toBeVisible();
    await expect(page.getByRole("button", { name: "生成班级反馈" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "停止生成" })).toHaveCount(0);
    expect(externalRequests).toEqual([]);
  });

  test("system UI exposes the WeCom extraction role and safe LLM cache maintenance", async ({ page }) => {
    const externalRequests = await blockExternalRequests(page);
    await page.goto("/system/configuration");
    await expect(page.getByRole("heading", { name: "LLM 配置" })).toBeVisible();
    await expect(page.getByText("模型角色分工", { exact: true })).toBeVisible();
    await expect(page.getByLabel("企微提取模型")).toBeVisible();

    await page.getByRole("link", { name: "维护与日志" }).click();
    await expect(page).toHaveURL(/\/system\/maintenance$/);
    await expect(page.getByRole("heading", { name: "维护与操作日志" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "操作日志", exact: true })).toBeVisible();
    await expect(page.getByText("LLM 本机缓存", { exact: true })).toBeVisible();
    await expect(page.getByText("正文需在本机目录查看", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "清理全部非活动缓存" })).toHaveClass(/ui-button--warning/);
    await expect(page.locator(".ui-button--danger")).toHaveCount(0);
    expect(externalRequests).toEqual([]);
  });
});
