import { expect, test } from "@playwright/test";
import { TEST_FIXTURE } from "../scripts/test-fixture-data";

const evidence = JSON.stringify({
  version: 2,
  planType: "event_micro",
  studentId: TEST_FIXTURE.students[0].id,
  teachingEvidence: [{ id: "event-1", kind: "fact", content: "氧化还原反应测验完成稳定", sourceRefs: [{ type: "event", id: "test-event-1" }], confirmed: true }],
  assessmentEvidence: [{ id: "assessment-1", kind: "fact", content: "出门测共 5 题，正确率 80%", sourceRefs: [{ type: "assessment-pdf", id: "test-assessment-1" }], confirmed: true }],
  communicationContext: [],
  executionConstraints: { existingTaskIds: [], fixedArrangementRefs: [], teacherInterventionPresent: false },
  sourceRefs: [{ type: "event", id: "test-event-1" }],
  sourceFingerprint: "e2e-feedback-plan-fingerprint-1",
  teachingBackground: ["课程标题：氧化还原"],
  historySnapshot: {
    version: 1,
    current: { metricId: "metric-current", sessionId: null, date: "本次课", semesterNumber: 0, scoreA: 5, scoreB: 4, scoreC: 4, scoreD: 3, present: true },
    previous: { metricId: "metric-previous", sessionId: TEST_FIXTURE.sessions[0].id, date: "2026-06-24", semesterNumber: 4, scoreA: 4, scoreB: 4, scoreC: 3, scoreD: 3 },
    recent: [{ metricId: "metric-previous", sessionId: TEST_FIXTURE.sessions[0].id, date: "2026-06-24", semesterNumber: 4, scoreA: 4, scoreB: 4, scoreC: 3, scoreD: 3 }],
    semesterAverage: { A: 4.5, B: 4, C: 3.5, D: 3 },
  },
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

function plan(text = "模型初稿：本次测验完成稳定。", status = "needs_review", planStatus = status === "approved" ? "approved" : "in_review", itemRevision = 2) {
  const generated = planStatus !== "draft";
  return {
    id: "e2e-feedback-plan-1",
    type: "event_micro",
    outputRequirement: "E2E 反馈计划",
    status: planStatus,
    generationMode: "fast",
    generationStartedAt: generated ? "2026-08-08T08:00:00.000Z" : null,
    generationCompletedAt: generated ? "2026-08-08T08:00:12.000Z" : null,
    generationTiming: generated ? { startedAt: "2026-08-08T08:00:00.000Z", completedAt: "2026-08-08T08:00:12.000Z", elapsedMs: 12_000, completedItems: 1, averageItemMs: 9_500, itemsPerMinute: 5, asOf: "2026-08-08T08:00:12.000Z" } : { startedAt: null, completedAt: null, elapsedMs: 0, completedItems: 0, averageItemMs: null, itemsPerMinute: null, asOf: "2026-08-08T08:00:00.000Z" },
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
      auditSnapshot: JSON.stringify({ version: 1, status: "needs_review", items: [{ code: "final_evidence_omitted", severity: "requires_teacher", message: "当前正文未呈现测评证据 assessment-1" }], textHash: "e2e-final-hash", semanticReviewRequired: false }),
      selectedGeneration: { inputSnapshot: JSON.stringify({ draftComposition: JSON.parse(composition) }) },
      itemRevision,
      generationStartedAt: generated ? "2026-08-08T08:00:00.500Z" : null,
      generationCompletedAt: generated ? "2026-08-08T08:00:12.000Z" : null,
      generationDurationMs: generated ? 9_500 : null,
      student: { name: TEST_FIXTURE.students[0].name, studentId: TEST_FIXTURE.students[0].studentId },
      tasks: [],
      attachments: [],
    }],
    exportRuns: [],
  };
}

test("feedback plan supports queued generation, teacher edit, approval and export", async ({ page }) => {
  let currentText = "模型初稿：本次测验完成稳定。";
  let currentStatus = "needs_review";
  let generated = false;
  let generatedItemIds: string[] = [];
  let generationMode = "";
  let successfulExports = 0;
  let planCreated = false;
  let currentPlanStatus = "draft";
  let currentRevision = 2;
  let createBody: Record<string, unknown> | null = null;
  let detailReads = 0;
  const mutationOrder: string[] = [];
  await page.route("**/api/report/feedback-plans**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/feedback-plans")) {
      await route.fulfill({ json: { plans: planCreated ? [plan(currentText, currentStatus, currentPlanStatus, currentRevision)] : [] } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/feedback-plans")) {
      createBody = request.postDataJSON() as Record<string, unknown>;
      planCreated = true;
      const created = plan("模型初稿：本次测验完成稳定。", "evidence_ready", "draft");
      await route.fulfill({ status: 201, json: { plan: { ...created, items: created.items.map((item) => ({ ...item, student: undefined })) } } });
      return;
    }
    if (url.pathname.endsWith("/e2e-feedback-plan-1") && request.method() === "GET") {
      detailReads += 1;
      await route.fulfill({ json: { plan: plan(currentText, currentStatus, currentPlanStatus, currentRevision) } });
      return;
    }
    if (url.pathname.endsWith("/e2e-feedback-plan-1") && request.method() === "PATCH") {
      mutationOrder.push("save");
      const body = request.postDataJSON() as { patch?: { finalText?: string } };
      if (body.patch?.finalText) currentText = body.patch.finalText;
      currentStatus = "needs_review";
      currentPlanStatus = "in_review";
      currentRevision = 3;
      await route.fulfill({ json: { item: plan(currentText, "needs_review", currentPlanStatus, currentRevision).items[0] } });
      return;
    }
    if (url.pathname.endsWith("/e2e-feedback-plan-1") && request.method() === "POST") {
      const body = request.postDataJSON() as { action?: string; allowRepeat?: boolean; itemIds?: string[]; generationMode?: string };
      if (body.action === "start_generation") {
        generated = true;
        generatedItemIds = body.itemIds ?? [];
        generationMode = typeof body.generationMode === "string" ? body.generationMode : "";
        currentStatus = "needs_review";
        currentPlanStatus = "in_review";
        await route.fulfill({ status: 202, json: { accepted: true, status: "queued" } });
        return;
      }
      if (body.action === "approve") {
        mutationOrder.push("approve");
        currentStatus = "approved";
        currentPlanStatus = "approved";
        await route.fulfill({ json: { plan: plan(currentText, "approved", currentPlanStatus, currentRevision) } });
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

  await page.goto("/feedback/advanced");
  // The shared context picker is also used by the preparation step. Use its
  // stable select order here so this integration test does not depend on the
  // browser's nested-label accessible-name implementation.
  const contextSelects = page.locator(".feedback-context-section select");
  await contextSelects.nth(0).selectOption(TEST_FIXTURE.semester.id);
  await contextSelects.nth(1).selectOption({ label: TEST_FIXTURE.class.name });
  await contextSelects.nth(2).selectOption(TEST_FIXTURE.sessions[0].code);

  await expect(page.getByText("学生出门测 PDF", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "2 录入 录入与提取课堂记录" }).click();
  await expect(page.getByText("学生出门测 PDF", { exact: true })).toBeVisible();
  await expect(page.getByText("选择报告文件夹", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "3 复核 复核并确认" }).click();
  const studentOne = page.getByRole("checkbox", { name: `${TEST_FIXTURE.students[0].name} 本次有明确课堂事件` });
  const studentTwo = page.getByRole("checkbox", { name: `${TEST_FIXTURE.students[1].name} 有确认记录，可手动加入` });
  await expect(studentOne).toBeChecked();
  await expect(studentTwo).not.toBeChecked();

  await expect(page.getByText("具体表现", { exact: true })).toBeVisible();
  await expect(page.getByText("学生本次具体表现", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "选择公共模块：具体表现" }).uncheck();
  await page.getByRole("checkbox", { name: "选择公共模块：教师判断" }).uncheck();
  await expect(page.getByRole("button", { name: "进入生成", exact: true })).toBeEnabled();

  const secondStudentCard = page.locator(".feedback-plan-candidate").filter({ hasText: TEST_FIXTURE.students[1].name });
  await secondStudentCard.getByRole("button", { name: "单独设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("该学生仍属于本批次");
  await page.getByLabel("这位学生的反馈类型").selectOption("stage_trend");
  await page.getByLabel("本生特殊处理要求").fill("只写这位学生的阶段变化");
  await page.getByRole("button", { name: "保存独立计划", exact: true }).click();
  await expect(secondStudentCard.getByRole("button", { name: "独立计划", exact: true })).toBeVisible();
  await expect(studentTwo).toBeChecked();

  await page.getByRole("button", { name: "进入生成", exact: true }).click();
  expect(createBody).toMatchObject({
    generationPreferences: { moduleKeys: [] },
    studentOverrides: [{ studentId: TEST_FIXTURE.students[1].id, generationConfig: { type: "stage_trend", outputRequirement: "只写这位学生的阶段变化" } }],
  });
  await expect(page.getByRole("heading", { name: "生成反馈" })).toBeVisible();
  await expect(page.getByText("最多同时生成 2 条", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "标准生成" })).toBeVisible();
  await page.getByRole("button", { name: "快速生成" }).click();
  await expect(page.getByText("本轮生成已完成", { exact: true })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("12秒", { exact: true })).toBeVisible();
  await expect(page.getByText("5 生/分钟", { exact: true })).toBeVisible();
  expect(generated).toBe(true);
  expect(generatedItemIds).toEqual(["e2e-feedback-item-1"]);
  expect(generationMode).toBe("fast");
  await page.getByRole("button", { name: "查看并编辑反馈" }).click();
  await expect(page.getByRole("heading", { name: "编辑与导出" })).toBeVisible();
  const terminalDetailReads = detailReads;
  await page.waitForTimeout(1_100);
  expect(detailReads).toBe(terminalDetailReads);

  const editor = page.getByLabel(`${TEST_FIXTURE.students[0].name}反馈计划文本`);
  await editor.fill("教师修改后的反馈文本。");
  await page.waitForTimeout(1_000);
  await expect(editor).toBeFocused();
  expect(mutationOrder).toEqual([]);
  await page.getByRole("button", { name: "批准所选可通过项" }).click();
  await expect(page.getByText(/请先保存所选反馈中的未保存修改/)).toBeVisible();
  expect(mutationOrder).toEqual([]);
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect.poll(() => mutationOrder).toEqual(["save"]);
  await expect(page.getByRole("button", { name: "已保存" })).toBeDisabled();
  await page.getByRole("button", { name: "批准所选可通过项" }).click();
  await expect.poll(() => mutationOrder).toEqual(["save", "approve"]);
  expect(currentText).toBe("教师修改后的反馈文本。");
  await expect(page.getByText("本课事实", { exact: true })).toBeVisible();
  await expect(page.getByText("模型建议（仅供参考）", { exact: true })).toBeVisible();
  await expect(page.getByText("教师最终正文", { exact: true })).toBeVisible();
  await expect(page.getByText("家庭沟通偏好", { exact: true })).toBeVisible();
  await expect(page.getByText("最近课堂评价", { exact: true })).toBeVisible();
  await expect(page.getByText("学期均值 A4.5 · B4 · C3.5 · D3", { exact: true })).toBeVisible();
  await expect(page.getByText("程序核验", { exact: true })).toBeVisible();
  await expect(page.getByText("教师最终正文：部分已确认证据没有写入正文", { exact: true })).toBeVisible();
  await expect(page.getByText("处理建议：", { exact: true })).toBeVisible();
  const feedbackCard = page.locator(".feedback-plan-item").first();
  expect(await feedbackCard.evaluate((card) => {
    const auditPanel = card.querySelector(".feedback-plan-audit-panel");
    const reviewGrid = card.querySelector(".feedback-plan-review-grid");
    return Boolean(auditPanel && reviewGrid && (auditPanel.compareDocumentPosition(reviewGrid) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);
  await expect(page.getByText("出门测详情", { exact: true })).toBeVisible();
  await expect(page.locator("details.feedback-plan-assessment-detail")).not.toHaveAttribute("open", "");
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
    await expect(page.getByRole("heading", { name: "课后任务" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("unified feedback keeps the approved three-stage strategy and focused student studio", async ({ page }) => {
  const detail = plan();
  await page.route("**/api/report/feedback-plans**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/feedback-plans")) {
      await route.fulfill({ json: { plans: [detail] } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/e2e-feedback-plan-1")) {
      await route.fulfill({ json: { plan: detail } });
      return;
    }
    await route.continue();
  });

  await page.goto(`/feedback?stage=studio&planId=e2e-feedback-plan-1&semesterId=${TEST_FIXTURE.semester.id}&class=${encodeURIComponent(TEST_FIXTURE.class.name)}&sessionCode=${TEST_FIXTURE.sessions[0].code}`);
  const stageNavigation = page.getByRole("navigation", { name: "课后任务阶段" });
  await expect(stageNavigation).toContainText("收集材料");
  await expect(stageNavigation).toContainText("确认事实");
  await expect(stageNavigation).toContainText("计划工作室");
  await expect(page.getByRole("heading", { name: "逐学生计划工作室" })).toBeVisible();
  await expect(page.getByLabel("计划学生导航")).toContainText(TEST_FIXTURE.students[0].name);
  await expect(page.getByRole("button", { name: /学生独立设置/ })).toBeVisible();
  await expect(page.getByText("教师最终正文", { exact: true })).toBeVisible();
  await expect(page.getByText("模型角色与生成设置", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "1 收集材料 统一投料" }).click();
  await page.getByRole("button", { name: "展开全部计划设置" }).click();
  await expect(page.getByRole("checkbox", { name: /具体表现/ })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /教师判断/ })).toBeVisible();
  await expect(page.getByText("当前课次未关联已确认的共同课材料", { exact: false })).toBeVisible();
});

test("unified studio can safely pause and continue an active generation queue", async ({ page }) => {
  let planStatus = "generating";
  const detail = () => plan("", planStatus === "paused" ? "queued" : "generating", planStatus);
  const actions: string[] = [];
  await page.route("**/api/report/feedback-plans**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/feedback-plans")) {
      await route.fulfill({ json: { plans: [detail()] } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/e2e-feedback-plan-1")) {
      await route.fulfill({ json: { plan: detail() } });
      return;
    }
    if (request.method() === "POST" && url.pathname.endsWith("/e2e-feedback-plan-1")) {
      const body = request.postDataJSON() as { action?: string };
      if (body.action === "pause_generation") {
        actions.push(body.action);
        planStatus = "paused";
        await route.fulfill({ status: 202, json: { accepted: true, status: "paused" } });
        return;
      }
      if (body.action === "continue_generation") {
        actions.push(body.action);
        planStatus = "generating";
        await route.fulfill({ status: 202, json: { accepted: true, status: "queued" } });
        return;
      }
    }
    await route.continue();
  });

  await page.goto(`/feedback?stage=studio&planId=e2e-feedback-plan-1&semesterId=${TEST_FIXTURE.semester.id}&class=${encodeURIComponent(TEST_FIXTURE.class.name)}&sessionCode=${TEST_FIXTURE.sessions[0].code}`);
  await expect(page.getByLabel("反馈生成进度")).toBeVisible();
  await page.getByRole("button", { name: "暂停生成", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续生成", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续生成", exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停生成", exact: true })).toBeVisible();
  expect(actions).toEqual(["pause_generation", "continue_generation"]);
});

test("export never reports an unfinished queued item as program-check passed", async ({ page }) => {
  const queuedPlan = plan("", "queued", "paused");
  await page.route("**/api/report/feedback-plans**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/feedback-plans")) {
      await route.fulfill({ json: { plans: [queuedPlan] } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/e2e-feedback-plan-1")) {
      await route.fulfill({ json: { plan: queuedPlan } });
      return;
    }
    await route.continue();
  });

  await page.goto(`/feedback?step=export&planId=e2e-feedback-plan-1&semesterId=${TEST_FIXTURE.semester.id}&class=${encodeURIComponent(TEST_FIXTURE.class.name)}&sessionCode=${TEST_FIXTURE.sessions[0].code}`);
  await expect(page.getByText("尚未完成核验", { exact: true })).toBeVisible();
  await expect(page.getByText("本条仍在生成队列中，当前没有可供核验的最终正文。", { exact: true })).toBeVisible();
  await expect(page.getByText("程序核验通过", { exact: true })).not.toBeVisible();
});

test("feedback item can adjust and restore its independent generation plan", async ({ page }) => {
  let independentConfig: Record<string, unknown> | null = null;
  let itemRevision = 2;
  const patchBodies: Array<Record<string, unknown>> = [];
  const detail = () => {
    const base = plan("模型初稿：本次测验完成稳定。", "needs_review", "in_review", itemRevision);
    return {
      ...base,
      input: { generationPreferences: { closureType: "positive_recognition", moduleKeys: [] } },
      items: base.items.map((item) => ({ ...item, generationConfig: independentConfig })),
    };
  };

  await page.route("**/api/report/feedback-plans**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/feedback-plans")) {
      await route.fulfill({ json: { plans: [detail()] } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/e2e-feedback-plan-1")) {
      await route.fulfill({ json: { plan: detail() } });
      return;
    }
    if (request.method() === "PATCH" && url.pathname.endsWith("/e2e-feedback-plan-1")) {
      const body = request.postDataJSON() as Record<string, unknown>;
      patchBodies.push(body);
      const patch = body.patch as { generationConfig?: Record<string, unknown> | null };
      independentConfig = patch.generationConfig ?? null;
      itemRevision += 1;
      await route.fulfill({ json: { item: detail().items[0] } });
      return;
    }
    await route.continue();
  });

  await page.goto(`/feedback?step=export&planId=e2e-feedback-plan-1&semesterId=${TEST_FIXTURE.semester.id}&class=${encodeURIComponent(TEST_FIXTURE.class.name)}&sessionCode=${TEST_FIXTURE.sessions[0].code}`);
  const card = page.locator(".feedback-plan-item").first();
  await card.getByText("计划结构、任务与附件", { exact: true }).click();
  await card.getByRole("button", { name: "设置独立计划", exact: true }).click();
  await page.getByLabel("这位学生的反馈类型").selectOption("course_end");
  await page.getByLabel("本生特殊处理要求").fill("只保留结课阶段中的关键变化");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "保存独立计划", exact: true }).click();
  await expect(card.getByText("独立计划", { exact: true })).toBeVisible();
  expect(patchBodies[0]).toMatchObject({ patch: { generationConfig: { type: "course_end", outputRequirement: "只保留结课阶段中的关键变化" } } });

  await expect(card.getByRole("button", { name: "调整独立计划", exact: true })).toBeVisible();
  await card.getByRole("button", { name: "调整独立计划", exact: true }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "恢复公共设置", exact: true }).click();
  await expect.poll(() => patchBodies.length).toBe(2);
  expect(patchBodies[1]).toMatchObject({ patch: { generationConfig: null } });
  await expect(card.getByRole("button", { name: "设置独立计划", exact: true })).toBeVisible();
});

test("feedback history uses readable linked selectors instead of internal id inputs", async ({ page }) => {
  await page.goto(`/history?semesterId=${TEST_FIXTURE.semester.id}`);
  const semester = page.getByLabel("学期", { exact: true });
  const classSelect = page.getByLabel("班级", { exact: true });
  const session = page.getByLabel("课次", { exact: true });
  const student = page.getByLabel("学生", { exact: true });
  await expect(semester).toHaveValue(TEST_FIXTURE.semester.id);
  await expect(classSelect.getByRole("option", { name: TEST_FIXTURE.class.name })).toBeAttached();
  await expect(student.locator("option")).toHaveCount(3);
  await classSelect.selectOption(TEST_FIXTURE.class.id);
  await expect(session.getByRole("option", { name: new RegExp(TEST_FIXTURE.sessions[0].code) })).toBeAttached();
  await expect(page.getByLabel("学期 ID", { exact: true })).toHaveCount(0);
});

test("review defaults to a new plan while history remains recoverable", async ({ page }) => {
  await page.route("**/api/report/feedback-plans**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname.endsWith("/feedback-plans")) {
      await route.fulfill({ json: { plans: [plan("既有计划正文", "approved", "approved")] } });
      return;
    }
    if (request.method() === "GET" && url.pathname.endsWith("/e2e-feedback-plan-1")) {
      await route.fulfill({ json: { plan: plan("既有计划正文", "approved", "approved") } });
      return;
    }
    await route.continue();
  });

  await page.goto("/feedback/advanced");
  const contextSelects = page.locator(".feedback-context-section select");
  await contextSelects.nth(0).selectOption(TEST_FIXTURE.semester.id);
  await contextSelects.nth(1).selectOption({ label: TEST_FIXTURE.class.name });
  await contextSelects.nth(2).selectOption(TEST_FIXTURE.sessions[0].code);
  await page.getByRole("button", { name: "3 复核 复核并确认" }).click();

  await expect(page.getByLabel("反馈要求与补充事实")).toBeVisible();
  await expect(page.getByText("已恢复反馈计划：事件型微反馈", { exact: false })).not.toBeVisible();
  await page.getByRole("button", { name: "事件型微反馈 · 已批准 · 1条" }).click();
  await expect(page.getByText("已恢复反馈计划：事件型微反馈", { exact: false })).toBeVisible();
  await expect(page.getByLabel("反馈要求与补充事实")).not.toBeVisible();

  await page.getByRole("button", { name: "新建反馈计划" }).click();
  await expect(page.getByLabel("反馈要求与补充事实")).toBeVisible();
  await expect(page.getByText("已恢复反馈计划：事件型微反馈", { exact: false })).not.toBeVisible();
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

  await page.goto("/feedback/advanced?step=prepare");
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

test("multi-class batch creation keeps class sessions and students explicit", async ({ page }) => {
  const classes = [
    { id: "batch-class-1", code: "B-01", name: "一班" },
    { id: "batch-class-2", code: "B-02", name: "二班" },
  ];
  const sessions = classes.map((item, index) => ({ id: `batch-session-${index + 1}`, code: `2098120${index + 1}01`, date: `2098-12-0${index + 1}`, classId: item.id }));
  const students = classes.map((item, index) => ({ id: `batch-student-${index + 1}`, name: `批次学生${index + 1}`, studentId: `B-S${index + 1}`, classId: item.id }));
  let created = false;
  let createBody: Record<string, unknown> | null = null;
  const batch = {
    id: "batch-e2e-1",
    semesterId: TEST_FIXTURE.semester.id,
    type: "event_micro",
    outputRequirement: "逐班生成反馈",
    status: "ready",
    currentPlanId: null,
    plans: classes.map((item, index) => ({ id: `batch-plan-${index + 1}`, batchOrder: index + 1, status: "draft", class: item, progress: { total: 1, generated: 0, approved: 0, exported: 0, failed: 0 } })),
    progress: { total: 2, generated: 0, approved: 0, exported: 0, failed: 0, completedClasses: 0, totalClasses: 2 },
  };
  await page.route("**/api/semesters", (route) => route.fulfill({ json: [TEST_FIXTURE.semester] }));
  await page.route(`**/api/semesters/${TEST_FIXTURE.semester.id}`, (route) => route.fulfill({ json: { ...TEST_FIXTURE.semester, classes, sessions } }));
  await page.route(`**/api/semesters/${TEST_FIXTURE.semester.id}/class-groups`, (route) => route.fulfill({ json: { groups: [] } }));
  await page.route("**/api/students?**", (route) => route.fulfill({ json: students }));
  await page.route("**/api/report/feedback-plan-batches**", async (route) => {
    if (route.request().method() === "POST") {
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      created = true;
      await route.fulfill({ status: 201, json: { batch } });
      return;
    }
    await route.fulfill({ json: { batches: created ? [batch] : [] } });
  });

  await page.goto(`/feedback/advanced?semesterId=${TEST_FIXTURE.semester.id}`);
  const panel = page.locator(".feedback-batch-panel");
  await panel.getByText("多班反馈批次（1.2 Beta）").click();
  await panel.getByLabel("B-01 一班").check();
  await panel.getByLabel("B-02 二班").check();
  await panel.getByRole("button", { name: "原子创建批次" }).click();
  await expect(panel.getByText("批次及各班独立反馈计划已原子创建。")).toBeVisible();
  expect(createBody).toMatchObject({
    semesterId: TEST_FIXTURE.semester.id,
    type: "event_micro",
    plans: [
      { classId: classes[0].id, sessionId: sessions[0].id, studentIds: [students[0].id] },
      { classId: classes[1].id, sessionId: sessions[1].id, studentIds: [students[1].id] },
    ],
  });
});
