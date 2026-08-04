import { expect, test } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

const evidence = JSON.stringify({
  version: 1,
  planType: "event_micro",
  studentId: TEST_FIXTURE.students[0].id,
  teachingEvidence: [{ id: "event-1", kind: "fact", content: "氧化还原反应测验完成稳定", sourceRefs: [{ type: "event", id: "test-event-1" }], confirmed: true }],
  communicationContext: [],
  executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
  sourceRefs: [{ type: "event", id: "test-event-1" }],
  sourceFingerprint: "e2e-feedback-plan-fingerprint-1",
});

const composition = JSON.stringify({
  version: 1,
  closureType: "positive_recognition",
  needParentAction: false,
  parentAction: null,
  modules: [
    { key: "observed_moment", content: "氧化还原反应测验完成稳定", evidenceRefs: ["event-1"], status: "included", reason: "具体表现" },
    { key: "teacher_interpretation", content: "本次方法使用较稳定", evidenceRefs: ["event-1"], status: "included", reason: "教师判断" },
  ],
  evidenceCoverage: [{ evidenceId: "event-1", statement: "本次测验完成稳定" }],
  draftFeedback: "模型初稿：本次测验完成稳定。",
});

function plan(text = "模型初稿：本次测验完成稳定。", status = "needs_review") {
  return {
    id: "e2e-feedback-plan-1",
    type: "event_micro",
    purpose: "E2E 反馈计划",
    status: status === "approved" ? "approved" : "in_review",
    sessionId: TEST_FIXTURE.sessions[0].id,
    rangeEndSessionId: TEST_FIXTURE.sessions[0].id,
    items: [{
      id: "e2e-feedback-item-1",
      studentId: TEST_FIXTURE.students[0].id,
      status,
      finalText: text,
      finalTextHash: "e2e-final-hash",
      evidenceSnapshot: evidence,
      compositionSnapshot: composition,
      auditSnapshot: JSON.stringify({ version: 1, status: "pass", items: [], textHash: "e2e-final-hash", semanticReviewRequired: false }),
      selectedGeneration: { inputSnapshot: JSON.stringify({ draftComposition: JSON.parse(composition) }) },
      itemRevision: 2,
      student: { name: TEST_FIXTURE.students[0].name, studentId: TEST_FIXTURE.students[0].studentId },
      tasks: [],
      attachments: [],
    }],
    exportRuns: [],
  };
}

test("feedback plan supports create, streamed generation, teacher edit, approval and export", async ({ page }) => {
  let currentText = "模型初稿：本次测验完成稳定。";
  let currentStatus = "needs_review";
  let generated = false;
  let generatedItemIds: string[] = [];
  let successfulExports = 0;
  let planCreated = false;
  await page.route("**/api/report/feedback-plans**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/feedback-plans")) {
      await route.fulfill({ json: { plans: planCreated ? [plan(currentText, currentStatus)] : [] } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/feedback-plans")) {
      planCreated = true;
      const created = plan("模型初稿：本次测验完成稳定。", "evidence_ready");
      await route.fulfill({ status: 201, json: { plan: { ...created, items: created.items.map((item) => ({ ...item, student: undefined })) } } });
      return;
    }
    if (url.pathname.endsWith("/e2e-feedback-plan-1") && request.method() === "GET") {
      await route.fulfill({ json: { plan: plan(currentText, currentStatus) } });
      return;
    }
    if (url.pathname.endsWith("/e2e-feedback-plan-1") && request.method() === "PATCH") {
      const body = request.postDataJSON() as { patch?: { finalText?: string } };
      if (body.patch?.finalText) currentText = body.patch.finalText;
      await route.fulfill({ json: { item: plan(currentText, "needs_review").items[0] } });
      return;
    }
    if (url.pathname.endsWith("/e2e-feedback-plan-1") && request.method() === "POST") {
      const body = request.postDataJSON() as { action?: string; allowRepeat?: boolean; itemIds?: string[] };
      if (body.action === "generate") {
        generated = true;
        generatedItemIds = body.itemIds ?? [];
        await route.fulfill({ status: 200, contentType: "application/x-ndjson; charset=utf-8", body: `{"type":"status","message":"开始生成 1 条反馈"}\n{"type":"item","itemId":"e2e-feedback-item-1","status":"needs_review"}\n` });
        return;
      }
      if (body.action === "approve") {
        currentStatus = "approved";
        await route.fulfill({ json: { plan: plan(currentText, "approved") } });
        return;
      }
      if (body.action === "export") {
        if (successfulExports > 0 && !body.allowRepeat) {
          await route.fulfill({ status: 409, json: { error: { code: "repeat_export", message: "这批反馈已经按相同文本导出过" } } });
          return;
        }
        successfulExports += 1;
        await route.fulfill({ status: 200, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: Buffer.concat([Buffer.from("PK synthetic workbook"), Buffer.alloc(600)]) });
        return;
      }
    }
    await route.continue();
  });

  await page.goto("/feedback");
  // The shared context picker is also used by the legacy workflow. Use its
  // stable select order here so this integration test does not depend on the
  // browser's nested-label accessible-name implementation.
  const contextSelects = page.locator(".feedback-context-section select");
  await contextSelects.nth(0).selectOption(TEST_FIXTURE.semester.id);
  await contextSelects.nth(1).selectOption({ label: TEST_FIXTURE.class.name });
  await contextSelects.nth(2).selectOption(TEST_FIXTURE.sessions[0].code);

  const studentOne = page.getByRole("checkbox", { name: `${TEST_FIXTURE.students[0].name} 本次有明确课堂事件` });
  const studentTwo = page.getByRole("checkbox", { name: `${TEST_FIXTURE.students[1].name} 有确认记录，可手动加入` });
  await expect(studentOne).toBeChecked();
  await expect(studentTwo).not.toBeChecked();

  await page.getByRole("button", { name: "创建反馈计划" }).click();
  await page.getByRole("button", { name: "4 生成 生成反馈" }).click();
  await page.reload();
  await expect(page.getByText("E2E 反馈计划", { exact: true })).toBeVisible();
  await expect(page.getByText("初稿 1/1 · 成稿 1/1 · pass", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重新组装/生成" }).click();
  await expect(page.getByText("生成进度 1/1", { exact: true })).toBeVisible();
  expect(generated).toBe(true);
  expect(generatedItemIds).toEqual(["e2e-feedback-item-1"]);

  const editor = page.getByLabel(`${TEST_FIXTURE.students[0].name}反馈计划文本`);
  await editor.fill("教师修改后的反馈文本。");
  await page.getByRole("button", { name: "保存修改" }).click();
  await page.getByRole("button", { name: "批准所选可通过项" }).click();
  await page.getByRole("button", { name: "5 导出 编辑与导出" }).click();
  const exportButton = page.getByRole("button", { name: "仅导出新批准项" });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(page.getByText("教师修改后的反馈文本。", { exact: true })).toBeVisible();
  await exportButton.click();
  await expect(page.getByRole("button", { name: "确认重复导出" })).toBeVisible();
  await page.getByRole("button", { name: "确认重复导出" }).click();
  expect(successfulExports).toBe(2);
  await page.getByRole("button", { name: "1 准备 选择课次与准备材料" }).click();
  await page.locator(".feedback-context-section select").nth(2).selectOption(TEST_FIXTURE.sessions[1].code);
  await expect(page.getByText("E2E 反馈计划", { exact: true })).not.toBeVisible();
});

test("feedback plan remains within the viewport at supported breakpoints", async ({ page }) => {
  for (const width of [1280, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/feedback");
    await expect(page.getByRole("heading", { name: "课后工作台" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("feedback preparation recommends and applies the current lesson script", async ({ page }) => {
  await page.route("**/api/feedback/script-library**", async (route) => {
    await route.fulfill({
      json: {
        recommendedLessonNumber: 2,
        library: {
          version: 1,
          name: "E2E 学期话术库",
          updatedAt: "2026-08-02T00:00:00.000Z",
          warnings: [],
          entries: [
            { lessonNumber: 1, topic: "集合", groupFeedback: "第一课群反馈", perfectPrivateFeedback: "第一课全对", errorPrivateFeedback: "第一课有误", note: "" },
            { lessonNumber: 2, topic: "函数", groupFeedback: "第二课群反馈", perfectPrivateFeedback: "第二课全对", errorPrivateFeedback: "第二课有误", note: "" },
          ],
        },
      },
    });
  });

  await page.goto("/feedback?step=prepare");
  const contextSelects = page.locator(".feedback-context-section select");
  await contextSelects.nth(0).selectOption(TEST_FIXTURE.semester.id);
  await contextSelects.nth(1).selectOption({ label: TEST_FIXTURE.class.name });
  await contextSelects.nth(2).selectOption(TEST_FIXTURE.sessions[1].code);

  await expect(page.getByLabel("本节进度")).toHaveValue("2");
  await page.getByRole("button", { name: "套用本节话术" }).click();
  await expect(page.getByLabel("群反馈原文")).toHaveValue("第二课群反馈");
  await expect(page.getByLabel("出门测统一说明")).toHaveValue("");
  await page.getByText("查看本节私反馈话术").click();
  await expect(page.getByText("第二课全对", { exact: true })).toBeVisible();
  await expect(page.getByText("第二课有误", { exact: true })).toBeVisible();
});
