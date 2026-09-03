import { expect, test } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

test.describe.serial("v0.17.0 information architecture", () => {
  test("dashboard persists the selected semester in the URL", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "学生仪表" })).toBeVisible();
    await page.getByLabel("查看学期").selectOption(TEST_FIXTURE.semester.id);
    await expect(page).toHaveURL(new RegExp(`semesterId=${TEST_FIXTURE.semester.id}`));
    await expect(page.getByText(`${TEST_FIXTURE.semester.name} · 学生警告、教师待办与学习状态`)).toBeVisible();
  });

  test("dashboard navigation separates student and class views", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "学生仪表", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "班级仪表", exact: true })).toBeVisible();
    await page.getByLabel("查看学期").selectOption(TEST_FIXTURE.semester.id);
    await page.getByRole("link", { name: "班级仪表", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/classes\\?semesterId=${TEST_FIXTURE.semester.id}`));
    await expect(page.getByRole("heading", { name: "班级仪表" })).toBeVisible();
    await expect(page.getByRole("link", { name: "班级仪表", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "学生仪表" })).toHaveCount(0);
    const classUrl = new URL(page.url());
    expect(classUrl.searchParams.has("class")).toBe(false);
    expect(classUrl.searchParams.has("classId")).toBe(false);
    expect(classUrl.searchParams.has("sessionCode")).toBe(false);

    await page.setViewportSize({ width: 720, height: 900 });
    await expect(page.locator(".app-mobile-bar strong")).toHaveText("班级仪表");
    await page.goto("/");
    await expect(page.locator(".app-mobile-bar strong")).toHaveText("学生仪表");
  });

  test("legacy routes open their v0.17 workspaces", async ({ context }) => {
    const inputPage = await context.newPage();
    await inputPage.goto("/input");
    await expect(inputPage).toHaveURL(/\/feedback\/tools\?tool=manual-facts/);
    await expect(inputPage.getByRole("heading", { name: "高级工具" })).toBeVisible();
    await inputPage.close();

    const settingsPage = await context.newPage();
    await settingsPage.goto("/settings");
    await expect(settingsPage).toHaveURL(/\/system\/configuration/);
    await expect(settingsPage.getByRole("heading", { name: "系统中心" })).toBeVisible();
    await settingsPage.close();

    const reportPage = await context.newPage();
    await reportPage.goto("/report");
    await expect(reportPage).toHaveURL(/\/daily-report/);
    await expect(reportPage.getByRole("heading", { name: "教学总结" })).toBeVisible();
    await reportPage.close();
  });

  test("system center exposes consistent about and license pages", async ({ page }) => {
    await page.goto("/system/about");
    await expect(page.getByRole("heading", { name: "关于 Student Track" })).toBeVisible();
    await expect(page.locator(".system-about-hero")).toBeVisible();
    await expect(page.locator(".system-about-card")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "版本更新" })).toBeVisible();
    await expect(page.locator(".system-changelog").getByText("v1.2.0-beta.2", { exact: true })).toBeVisible();
    await expect(page.getByText("共同课与 STEP 基础", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const licenseTab = page.locator(".system-nav").getByRole("link", { name: "开源许可" });
    await expect(licenseTab).toBeVisible();
    await licenseTab.click();
    await expect(page.getByRole("heading", { name: "开源许可", exact: true })).toBeVisible();
    await expect(page.locator(".system-license-text")).toContainText("GNU AFFERO GENERAL PUBLIC LICENSE");
  });

  test("teaching summary uses the shared teaching context", async ({ page }) => {
    await page.goto("/daily-report");
    await page.getByLabel("学期").selectOption(TEST_FIXTURE.semester.id);
    await page.getByLabel("班级").selectOption({ label: TEST_FIXTURE.class.name });
    await page.getByLabel("课次").selectOption(TEST_FIXTURE.sessions[0].code);
    await expect(page.getByRole("heading", { name: "确定性待办" })).toBeVisible();
    await expect(page.getByText(TEST_FIXTURE.class.name, { exact: true }).last()).toBeVisible();
  });

  test("teaching context and an unfinished entry survive page switches", async ({ page }) => {
    await page.goto("/feedback/tools?tool=manual-facts&step=input");
    await page.getByLabel("学期").selectOption(TEST_FIXTURE.semester.id);
    await page.getByLabel("班级").selectOption({ label: TEST_FIXTURE.class.name });
    await page.locator("select").nth(2).selectOption(TEST_FIXTURE.sessions[0].code);
    const classroomInput = page.getByPlaceholder("例如：今天张三测验氧化还原全对，但上课走神。李四作业没交，情绪低落。给王五的妈妈打了电话讨论近况。");
    await classroomInput.fill("E2E 未提交课堂回顾");

    await page.getByRole("link", { name: "教学总结" }).click();
    await expect(page).toHaveURL(new RegExp(`semesterId=${TEST_FIXTURE.semester.id}`));
    await expect(page.getByLabel(/班级选择班级/)).toHaveValue(TEST_FIXTURE.class.id);
    await expect(page.getByLabel(/课次选择课次/)).toHaveValue(TEST_FIXTURE.sessions[0].code);

    await page.goto("/feedback/tools?tool=manual-facts&step=input");
    await expect(page.getByPlaceholder("例如：今天张三测验氧化还原全对，但上课走神。李四作业没交，情绪低落。给王五的妈妈打了电话讨论近况。")).toHaveValue("E2E 未提交课堂回顾");
  });

  test("workspace drafts debounce continuous text input", async ({ page, request }) => {
    const created = await request.post("/api/report/feedback-plans", { data: {
      displayName: "E2E 连续输入防抖计划",
      type: "event_micro",
      outputRequirement: "E2E 初始要求",
      generationMode: "standard",
      semesterId: TEST_FIXTURE.semester.id,
      classId: TEST_FIXTURE.class.id,
      sessionId: TEST_FIXTURE.sessions[0].id,
      studentIds: TEST_FIXTURE.students.map((student) => student.id),
    } });
    expect(created.ok()).toBeTruthy();
    const plan = (await created.json()).plan as { id: string };
    const detailPath = `/api/report/feedback-plans/${plan.id}`;
    let saveCount = 0;
    page.on("request", (outgoing) => {
      if (new URL(outgoing.url()).pathname === detailPath && outgoing.method() === "PATCH") saveCount += 1;
    });
    await page.goto(`/feedback?semesterId=${TEST_FIXTURE.semester.id}&classId=${TEST_FIXTURE.class.id}&class=${encodeURIComponent(TEST_FIXTURE.class.name)}&sessionCode=${TEST_FIXTURE.sessions[0].code}&planId=${plan.id}&view=plan`);
    const requirement = page.getByLabel("总体要求").first();
    await expect(requirement).toBeVisible();

    await requirement.click();
    await requirement.type("连续输入保持流畅", { delay: 40 });
    await expect(requirement).toBeFocused();
    await expect.poll(() => saveCount, { timeout: 3_000 }).toBe(1);
    await page.waitForTimeout(900);
    expect(saveCount).toBe(1);
  });

  test("an unsaved quick-score edit survives page switches", async ({ page }) => {
    await page.goto("/quick-score");
    await page.getByLabel("学期", { exact: true }).selectOption(TEST_FIXTURE.semester.id);
    await page.getByLabel("班级", { exact: true }).selectOption({ label: TEST_FIXTURE.class.name });
    await page.getByLabel("课次", { exact: true }).selectOption(TEST_FIXTURE.sessions[0].code);
    const studentCard = page.getByText(TEST_FIXTURE.students[1].name, { exact: true }).locator("..").locator("..");
    await studentCard.getByText("学习", { exact: true }).locator("..").getByRole("button", { name: "4", exact: true }).click();
    await expect(page.getByText("已修改 1/", { exact: false })).toBeVisible();

    await page.getByRole("link", { name: "反馈历史" }).click();
    await expect(page.getByRole("heading", { name: "反馈历史" })).toBeVisible();
    await page.getByRole("link", { name: "手动评分" }).click();
    const restoredCard = page.getByText(TEST_FIXTURE.students[1].name, { exact: true }).locator("..").locator("..");
    await expect(restoredCard.getByText("学习", { exact: true }).locator("..").getByRole("button", { name: "4", exact: true })).toHaveClass(/scale-110/);
    await expect(page.getByText("已修改 1/", { exact: false })).toBeVisible();
  });

  test("quick score uses recoverable errors and an accessible delete confirmation", async ({ page }) => {
    const studentsApi = /\/api\/students(?:\?.*)?$/;
    await page.route(studentsApi, (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "E2E 学生加载失败" }),
    }));
    await page.goto("/quick-score");
    await expect(page.getByText("E2E 学生加载失败")).toBeVisible();

    await page.unroute(studentsApi);
    await page.reload();
    await page.getByLabel("学期", { exact: true }).selectOption(TEST_FIXTURE.semester.id);
    await page.getByLabel("班级", { exact: true }).selectOption({ label: TEST_FIXTURE.class.name });
    await page.getByLabel("课次", { exact: true }).selectOption(TEST_FIXTURE.sessions[0].code);
    await page.getByRole("button", { name: "删除课次" }).click();
    await expect(page.getByRole("dialog", { name: "删除当前课次" })).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("dialog", { name: "删除当前课次" })).toHaveCount(0);
    await expect(page.getByLabel("课次", { exact: true })).toHaveValue(TEST_FIXTURE.sessions[0].code);
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
    for (const width of [800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/feedback");
      await expect(page.getByRole("heading", { name: "课后工作台" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px should not overflow`).toBe(true);
    }
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
    const nameInput = page.getByLabel("姓名");
    await nameInput.type("测试学生", { delay: 40 });
    await expect(nameInput).toHaveValue("测试学生");
    await expect(nameInput).toBeFocused();
    const labelInput = page.getByLabel("标签");
    await labelInput.fill("组合标签");
    await labelInput.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await expect(labelInput).toHaveValue("组合标签");
    await expect(page.getByText("组合标签", { exact: true })).toHaveCount(0);
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
    await expect(page.getByRole("heading", { name: "操作日志", exact: true })).toBeVisible();
    await expect(page.getByLabel("操作类型")).toBeVisible();
    await expect(page.getByLabel("对象名称")).toBeVisible();
    await expect(page.getByText("测试学生")).toBeVisible();
    await expect(page.locator(".system-log-table-wrap")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("remaining management pages use stable narrow layouts", async ({ context }) => {
    for (const [path, heading] of [["/history", "反馈历史"], ["/export", "数据导出"], ["/semesters", "学期 / 课次"]] as const) {
      const page = await context.newPage();
      await page.setViewportSize({ width: 720, height: 900 });
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.close();
    }
  });

  test("all remaining core workspaces avoid page-level narrow overflow", async ({ context }) => {
    test.setTimeout(90_000);
    const paths = [
      "/", "/dashboard/classes", "/quick-score", "/feedback/tools?tool=manual-facts", "/daily-report", "/diarize",
      `/students/${TEST_FIXTURE.students[0].id}?semesterId=${TEST_FIXTURE.semester.id}`,
      `/semesters/${TEST_FIXTURE.semester.id}`, "/system/integrations",
    ];
    for (const path of paths) {
      const page = await context.newPage();
      await page.setViewportSize({ width: 720, height: 900 });
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("main, .dashboard-overview, .system-center").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${path} should not overflow`).toBe(true);
      await page.close();
    }
  });
});
