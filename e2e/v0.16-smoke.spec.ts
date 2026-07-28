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
  if (await classSelect.inputValue() !== TEST_FIXTURE.class.name) {
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
    await page.getByRole("button", { name: "全部提交" }).click();
    await expect(page.getByText("已提交 1 条评分", { exact: false })).toBeVisible();

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

  test("feedback loads context, uses a browser mock, and restores work history", async ({ page }) => {
    const externalRequests = await blockExternalRequests(page);
    const feedbackRequests: Array<Record<string, unknown>> = [];
    await page.route("**/api/feedback/assessment-pdf", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          fileName: "04示例报告（张三）.pdf",
          reportStudentName: TEST_FIXTURE.students[0].name,
          reportStudentId: TEST_FIXTURE.students[0].studentId,
          matchedStudentId: TEST_FIXTURE.students[0].id,
          matchedStudentName: TEST_FIXTURE.students[0].name,
          matchStatus: "matched",
          evidence: {
            sessionCode: TEST_FIXTURE.sessions[0].code,
            studentId: TEST_FIXTURE.students[0].id,
            reportTitle: "04示例基础",
            reportDate: "2099-07-13",
            totalQuestions: 5,
            correctRate: 80,
            cohortAverageRate: 72.2,
            knowledgePoints: [],
            wrongItems: [],
            similarPracticeCount: 1,
          },
        }),
      });
    });
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
          kind: "batch",
          semesterId: TEST_FIXTURE.semester.id,
          sessionCode: TEST_FIXTURE.sessions[0].code,
          className: TEST_FIXTURE.class.name,
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
    await page.getByLabel("群反馈原文").fill("高一化学群反馈《示例课程》\n【课堂内容】\n1. 示例内容\n【课堂重点】\n1. 示例重点");
    await page.getByLabel("出门测统一说明").fill("这次出门测主要考察以下内容：\n1. 示例概念\n孩子这次存在一定错误。\n请结合视频订正。");
    await page.getByRole("button", { name: "一键整理全部" }).click();
    await expect(page.getByLabel("课程主题")).toHaveValue("示例课程");
    await page.locator('label:has-text("补选 PDF") input[type="file"]').setInputFiles({
      name: "04示例报告（张三）.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 synthetic"),
    });
    await expect(page.getByText("待确认", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "批量确认匹配" }).click();
    await expect(page.getByText("已采用 1 份报告", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "4 生成 生成反馈" }).click();
    await page.getByRole("button", { name: "生成班级反馈" }).click();
    await expect(page.getByText("已按本次反馈强度生成家长话术，请逐条检查后再导出。", { exact: true })).toBeVisible();
    await expect(page.getByText(`模拟反馈：${TEST_FIXTURE.students[0].name}本节课表现稳定。`, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "重新生成" }).click();
    await expect(page.getByText("旧批次已从当前工作区移除；下一次生成将使用当前模型重新处理。", { exact: true })).toBeVisible();
    await expect(page.getByText(`模拟反馈：${TEST_FIXTURE.students[0].name}本节课表现稳定。`, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "生成班级反馈" }).click();
    await expect.poll(() => feedbackRequests.length).toBe(2);
    expect(feedbackRequests[1]).toMatchObject({ bypassCache: true });
    expect(feedbackRequests[1]).toMatchObject({
      lessonMaterial: expect.objectContaining({ lessonTitle: "示例课程" }),
      assessmentEvidence: {
        [TEST_FIXTURE.students[0].id]: expect.objectContaining({ correctRate: 80 }),
      },
    });

    await page.getByRole("button", { name: "历史", exact: true }).click();
    const historyRow = page.getByText(TEST_FIXTURE.feedbackHistory.title, { exact: true }).locator("..").locator("..");
    await historyRow.getByRole("button", { name: "恢复" }).click();
    await expect(page.getByText("已恢复历史反馈结果。", { exact: true })).toBeVisible();
    await expect(page.getByText(`历史恢复反馈：${TEST_FIXTURE.students[0].name}表现稳定。`, { exact: true })).toBeVisible();
    expect(externalRequests).toEqual([]);
  });

  test("feedback generation can be cancelled without showing a failure state", async ({ page }) => {
    let releaseRequest: () => void = () => undefined;
    const heldRequest = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route("**/api/report/feedback-batch", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      await heldRequest;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          kind: "batch",
          semesterId: TEST_FIXTURE.semester.id,
          sessionCode: TEST_FIXTURE.sessions[0].code,
          className: TEST_FIXTURE.class.name,
          total: TEST_FIXTURE.students.length,
          cached: false,
          students: TEST_FIXTURE.students.map((student) => ({
            id: student.id,
            name: student.name,
            labels: [],
            feedback: "",
          })),
        }),
      }).catch(() => undefined);
    });

    await page.goto("/feedback");
    await page.locator("select").nth(0).selectOption(TEST_FIXTURE.semester.id);
    await page.locator("select").nth(1).selectOption({ label: TEST_FIXTURE.class.name });
    await page.locator("select").nth(2).selectOption(TEST_FIXTURE.sessions[0].code);
    await page.getByRole("button", { name: "4 生成 生成反馈" }).click();
    await page.getByRole("button", { name: "分析并生成反馈" }).click();
    const stopButton = page.getByRole("button", { name: "停止生成" });
    await expect(stopButton).toHaveClass(/ui-button--warning/);
    await stopButton.click();
    await expect(page.getByText("已取消本次反馈生成；未完成的结果不会保存。", { exact: true })).toBeVisible();
    await expect(page.getByText("批量生成失败", { exact: true })).toHaveCount(0);
    releaseRequest();
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
