import { expect, test } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

test.describe.serial("v0.17.0 information architecture", () => {
  test("dashboard persists the selected semester in the URL", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "仪表盘" })).toBeVisible();
    await page.getByLabel("查看学期").selectOption(TEST_FIXTURE.semester.id);
    await expect(page).toHaveURL(new RegExp(`semesterId=${TEST_FIXTURE.semester.id}`));
    await expect(page.getByText(`${TEST_FIXTURE.semester.name} · 学期概览与风险提示`)).toBeVisible();
  });

  test("legacy routes open their v0.17 workspaces", async ({ page }) => {
    await page.goto("/input");
    await expect(page).toHaveURL(/\/entry\?step=input/);
    await expect(page.getByRole("heading", { name: "课堂录入" })).toBeVisible();

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/system\/configuration/);
    await expect(page.getByRole("heading", { name: "系统中心" })).toBeVisible();

    await page.goto("/report");
    await expect(page).toHaveURL(/\/daily-report/);
    await expect(page.getByRole("heading", { name: "班级日报" })).toBeVisible();
  });

  test("daily report uses the shared teaching context", async ({ page }) => {
    await page.route("**/api/report/daily", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ report: "E2E 班级日报：课堂状态稳定。" }) }));
    await page.goto("/daily-report");
    await page.getByLabel("学期").selectOption(TEST_FIXTURE.semester.id);
    await page.getByLabel("班级").selectOption({ label: TEST_FIXTURE.class.name });
    await page.getByLabel("课次").selectOption(TEST_FIXTURE.sessions[0].code);
    await page.getByRole("button", { name: "生成班级日报" }).click();
    await expect(page.getByText("E2E 班级日报：课堂状态稳定。")).toBeVisible();
  });

  test("teaching context and an unfinished entry survive page switches", async ({ page }) => {
    await page.goto("/entry?step=input");
    await page.getByLabel("学期").selectOption(TEST_FIXTURE.semester.id);
    await page.getByLabel("班级").selectOption({ label: TEST_FIXTURE.class.name });
    await page.getByLabel("课次").selectOption(TEST_FIXTURE.sessions[0].code);
    await page.getByPlaceholder("例如：今天张三测验氧化还原全对，但上课走神。李四作业没交，情绪低落。给王五的妈妈打了电话讨论近况。").fill("E2E 未提交课堂回顾");

    await page.getByRole("link", { name: "班级日报" }).click();
    await expect(page).toHaveURL(new RegExp(`semesterId=${TEST_FIXTURE.semester.id}`));
    await expect(page.getByLabel("班级")).toHaveValue(TEST_FIXTURE.class.name);
    await expect(page.getByLabel("课次")).toHaveValue(TEST_FIXTURE.sessions[0].code);

    await page.getByRole("link", { name: "课堂录入" }).click();
    await expect(page.getByRole("textbox")).toHaveValue("E2E 未提交课堂回顾");
  });

  test("an unsaved quick-score edit survives page switches", async ({ page }) => {
    await page.goto("/quick-score");
    await page.locator("select").nth(1).selectOption({ label: TEST_FIXTURE.class.name });
    await page.locator("select").nth(2).selectOption(TEST_FIXTURE.sessions[0].code);
    const studentCard = page.getByText(TEST_FIXTURE.students[1].name, { exact: true }).locator("..").locator("..");
    await studentCard.getByText("学习", { exact: true }).locator("..").getByRole("button", { name: "4", exact: true }).click();
    await expect(page.getByText("已修改 1/", { exact: false })).toBeVisible();

    await page.getByRole("link", { name: "工作历史" }).click();
    await page.getByRole("link", { name: "手动评分" }).click();
    const restoredCard = page.getByText(TEST_FIXTURE.students[1].name, { exact: true }).locator("..").locator("..");
    await expect(restoredCard.getByText("学习", { exact: true }).locator("..").getByRole("button", { name: "4", exact: true })).toHaveClass(/scale-110/);
    await expect(page.getByText("已修改 1/", { exact: false })).toBeVisible();
  });

  test("an unfinished feedback review survives page switches", async ({ page }) => {
    await page.goto("/feedback");
    await page.getByLabel("学期").selectOption(TEST_FIXTURE.semester.id);
    await page.getByLabel("班级").selectOption({ label: TEST_FIXTURE.class.name });
    await page.locator("select").nth(2).selectOption(TEST_FIXTURE.sessions[0].code);
    const review = page.getByPlaceholder("写下这节课对反馈有用的事实。未提及学生会按缺勤补齐。");
    await review.fill("E2E 未生成反馈的课堂回顾");

    await page.getByRole("link", { name: "工作历史" }).click();
    await page.getByRole("link", { name: "课后反馈" }).click();
    await expect(page.getByPlaceholder("写下这节课对反馈有用的事实。未提及学生会按缺勤补齐。")).toHaveValue("E2E 未生成反馈的课堂回顾");
    await expect(page.locator("select").nth(2)).toHaveValue(TEST_FIXTURE.sessions[0].code);
  });

  test("narrow windows use the accessible navigation drawer", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "打开导航" }).click();
    await expect(page.getByRole("dialog", { name: "主导航抽屉" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
    await page.getByRole("link", { name: "系统中心" }).click();
    await expect(page).toHaveURL(/\/system\/configuration/);
    await expect(page.getByRole("heading", { name: "系统中心" })).toBeVisible();
  });

  test("feedback workspace does not overflow a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto("/feedback");
    await expect(page.getByRole("heading", { name: "课后反馈工作台" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("student navigation keeps the selected semester without unrelated class parameters", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("查看学期").selectOption(TEST_FIXTURE.semester.id);
    await page.getByRole("link", { name: "学生档案" }).click();
    await expect(page).toHaveURL(new RegExp(`/students\\?semesterId=${TEST_FIXTURE.semester.id}`));
    expect(new URL(page.url()).searchParams.has("class")).toBe(false);
    expect(new URL(page.url()).searchParams.has("sessionCode")).toBe(false);
  });

  test("student list dialogs remain accessible in a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto("/students");
    await expect(page.getByRole("heading", { name: "学生档案" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole("button", { name: "添加学生" }).click();
    await expect(page.getByRole("dialog", { name: "添加学生" })).toBeVisible();
    await page.getByRole("button", { name: "关闭" }).click();

    await page.getByRole("button", { name: "导入花名册" }).click();
    await expect(page.getByRole("dialog", { name: "导入花名册" })).toBeVisible();
    await page.getByRole("button", { name: "关闭" }).click();
  });

  test("LLM configuration uses recoverable status and confirmation UI", async ({ page }) => {
    const profile = { id: "e2e-profile", name: "E2E 本地模型", apiBaseUrl: "http://127.0.0.1:65535/v1", apiKey: "local-test", model: "e2e-model", createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z" };
    await page.route("**/api/settings/llm**", async (route) => {
      const saved = route.request().method() === "PUT";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ activeProfileId: null, profiles: saved ? [profile] : [], effectiveSettings: { apiBaseUrl: profile.apiBaseUrl, apiKey: profile.apiKey, model: profile.model } }) });
    });
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto("/system/configuration");
    await page.getByLabel("配置名称").fill(profile.name);
    await page.getByLabel("API Base URL").fill(profile.apiBaseUrl);
    await page.getByLabel("API Key").fill(profile.apiKey);
    await page.getByLabel("模型名").fill(profile.model);
    await page.getByRole("button", { name: "仅保存" }).click();
    await expect(page.getByText("已保存。")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "删除当前配置" }).click();
    await expect(page.getByRole("dialog", { name: "删除当前配置" })).toBeVisible();
  });

  test("system navigation and maintenance logs stay contained on narrow screens", async ({ page }) => {
    await page.route("**/api/system/logs**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 1, logs: [{ id: "log-1", action: "score.updated", targetType: "Student", targetId: "student-1", targetName: "测试学生", detail: { summary: "一段很长但只能在表格容器内部滚动的操作详情" }, createdAt: "2026-07-14T00:00:00.000Z" }] }) }));
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto("/system/maintenance");
    await expect(page.getByRole("link", { name: "维护与日志" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("测试学生")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
