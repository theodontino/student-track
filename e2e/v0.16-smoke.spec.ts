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
  const classSelect = page.locator("select").nth(1);
  await expect(classSelect).toBeEnabled();
  if (await classSelect.inputValue() !== TEST_FIXTURE.class.name) {
    await classSelect.selectOption({ label: TEST_FIXTURE.class.name });
  }
  await expect(page.getByText(TEST_FIXTURE.students[0].name, { exact: true })).toBeVisible();
  await expect(page.locator("select")).toHaveCount(3);
}

test.describe.serial("v0.16.0 core browser smoke tests", () => {
  test("quick score saves attendance and scores, then reloads them", async ({ page }) => {
    const externalRequests = await blockExternalRequests(page);
    await page.goto("/quick-score");
    await expect(page.getByRole("heading", { name: "手动评分" })).toBeVisible();
    await selectQuickScoreClass(page);
    await page.locator("select").nth(2).selectOption(TEST_FIXTURE.sessions[0].code);

    const studentCard = page.getByText(TEST_FIXTURE.students[0].name, { exact: true }).locator("..").locator("..");
    await studentCard.getByTitle("点击标记缺勤").click();
    await studentCard.getByText("学习", { exact: true }).locator("..").getByRole("button", { name: "5", exact: true }).click();
    await page.getByRole("button", { name: "全部提交" }).click();
    await expect(page.getByText("已提交 1 条评分", { exact: false })).toBeVisible();

    await page.reload();
    await selectQuickScoreClass(page);
    await page.locator("select").nth(2).selectOption(TEST_FIXTURE.sessions[0].code);
    const reloadedCard = page.getByText(TEST_FIXTURE.students[0].name, { exact: true }).locator("..").locator("..");
    await expect(reloadedCard.getByTitle("点击标记出勤")).toBeVisible();
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

  test("feedback loads context, uses a browser mock, and restores work history", async ({ page }) => {
    const externalRequests = await blockExternalRequests(page);
    const feedbackRequests: Array<Record<string, unknown>> = [];
    await page.route("**/api/report/feedback-batch", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      feedbackRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total: TEST_FIXTURE.students.length,
          cached: false,
          students: TEST_FIXTURE.students.map((student) => ({
            id: student.id,
            name: student.name,
            labels: [],
            feedback: `模拟反馈：${student.name}本节课表现稳定。`,
            draftFeedback: `模拟反馈：${student.name}本节课表现稳定。`,
            reviewStatus: "passed",
            reviewIssues: [],
          })),
        }),
      });
    });

    await page.goto("/feedback");
    await expect(page.getByRole("heading", { name: "课后工作台" })).toBeVisible();
    await page.locator("select").nth(0).selectOption(TEST_FIXTURE.semester.id);
    await page.locator("select").nth(1).selectOption({ label: TEST_FIXTURE.class.name });
    await page.locator("select").nth(2).selectOption(TEST_FIXTURE.sessions[0].code);
    await expect(page.getByRole("heading", { name: "生成前上下文预览" })).toBeVisible();
    await expect(page.getByText(TEST_FIXTURE.students[0].name, { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "4 生成 生成反馈" }).click();
    await page.getByRole("button", { name: "分析并生成反馈" }).click();
    await expect(page.getByText("趋势与历史分析已转换成家长话术，并完成 AI 审核。", { exact: true })).toBeVisible();
    await expect(page.getByText("家长话术已完成 AI 审核，请逐条检查后再导出。", { exact: true })).toBeVisible();
    await expect(page.getByText(`模拟反馈：${TEST_FIXTURE.students[0].name}本节课表现稳定。`, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "重新生成" }).click();
    await expect(page.getByText("旧批次已从当前工作区移除；下一次生成将使用当前模型重新处理。", { exact: true })).toBeVisible();
    await expect(page.getByText(`模拟反馈：${TEST_FIXTURE.students[0].name}本节课表现稳定。`, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "分析并生成反馈" }).click();
    await expect.poll(() => feedbackRequests.length).toBe(2);
    expect(feedbackRequests[1]).toMatchObject({ bypassCache: true });

    await page.getByRole("button", { name: "历史", exact: true }).click();
    const historyRow = page.getByText(TEST_FIXTURE.feedbackHistory.title, { exact: true }).locator("..").locator("..");
    await historyRow.getByRole("button", { name: "恢复" }).click();
    await expect(page.getByText("已恢复历史反馈结果。", { exact: true })).toBeVisible();
    await expect(page.getByText(`历史恢复反馈：${TEST_FIXTURE.students[0].name}表现稳定。`, { exact: true })).toBeVisible();
    expect(externalRequests).toEqual([]);
  });

  test("system UI exposes the WeCom extraction role and safe LLM cache maintenance", async ({ page }) => {
    const externalRequests = await blockExternalRequests(page);
    await page.goto("/system/configuration");
    await expect(page.getByRole("heading", { name: "LLM 配置" })).toBeVisible();
    await expect(page.getByText("模型角色分工", { exact: true })).toBeVisible();
    await expect(page.getByLabel("企微提取模型")).toBeVisible();

    await page.goto("/system/maintenance");
    await expect(page.getByRole("heading", { name: "维护与操作日志" })).toBeVisible();
    await expect(page.getByText("LLM 本机缓存", { exact: true })).toBeVisible();
    await expect(page.getByText("正文需在本机目录查看", { exact: false })).toBeVisible();
    expect(externalRequests).toEqual([]);
  });
});
