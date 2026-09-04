import { expect, test, type APIResponse } from "@playwright/test";
import * as XLSX from "xlsx";

const unavailablePayload = {
  error: "当前 Core 版未包含此功能",
  code: "feature_unavailable",
  retryable: false,
};

async function expectOk(response: APIResponse) {
  if (!response.ok()) throw new Error(`HTTP ${response.status()}: ${await response.text()}`);
  return response;
}

function publicMaterialWorkbook() {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["Core E2E 学期公共材料"],
    ["课次", "课程主题", "群反馈", "统一测评说明", "全对的私反馈", "有错误的私反馈", "备注"],
    [1, "物质的量", "本讲梳理物质的量换算。", "完成一道课堂检测。", "计算过程准确。", "订正单位换算。", "固定合成材料"],
  ]), "学期公共材料");
  return Buffer.from(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}

test.describe("Student Track Core edition", () => {
  test.skip(process.env.E2E_FIXTURE_PROFILE !== "core", "仅由 Core 浏览器门禁使用空白隔离库运行");

  test("runs the Core gate and the ordinary teaching-to-backup workflow", async ({ page, request }) => {
    test.setTimeout(120_000);

    await test.step("空库仍展示 Full 功能入口，但入口不可点击", async () => {
      const emptySemesters = await expectOk(await request.get("/api/semesters"));
      expect(await emptySemesters.json()).toEqual([]);

      await page.goto("/");
      const sidebar = page.locator(".app-sidebar");
      for (const label of ["录音转写", "企微家校"]) {
        const item = sidebar.locator('.app-nav__disabled[aria-disabled="true"]', { hasText: label });
        await expect(item).toBeVisible();
        await expect(item.getByText("Full 版功能", { exact: true })).toBeVisible();
        await expect(item.locator("a")).toHaveCount(0);
      }
      await expect(sidebar.getByRole("link", { name: "手动评分" })).toBeVisible();

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "打开导航" }).click();
      const drawer = page.getByRole("dialog", { name: "主导航抽屉" });
      for (const label of ["录音转写", "企微家校"]) {
        const item = drawer.locator('.app-nav__disabled[aria-disabled="true"]', { hasText: label });
        await expect(item).toBeVisible();
        await expect(item.getByText("Full 版功能", { exact: true })).toBeVisible();
        await expect(item.locator("a")).toHaveCount(0);
      }
      await page.getByRole("button", { name: "关闭导航" }).click();
      await page.setViewportSize({ width: 1280, height: 720 });
    });

    await test.step("直达页说明不可用，受限 API 统一返回 404", async () => {
      for (const [path, title] of [
        ["/diarize", "录音转写不可用"],
        ["/wecom", "企微家校不可用"],
        ["/system/integrations", "集成与本地工具不可用"],
      ] as const) {
        await page.goto(path);
        await expect(page.getByRole("heading", { name: title })).toBeVisible();
        await expect(page.getByText("当前安装的是 Student Track Core 版。", { exact: true })).toBeVisible();
      }

      for (const path of [
        "/api/diarize/tasks",
        "/api/wecom/handoff",
        "/api/integrations/wecomcatch/v1/directory",
        "/api/system/local-tools",
      ]) {
        const response = await request.get(path);
        expect(response.status(), path).toBe(404);
        expect(await response.json()).toEqual(unavailablePayload);
      }
    });

    await test.step("高级工具与系统配置没有绕行入口，普通 PDF API 仍可访问", async () => {
      await page.goto("/feedback/tools?tool=manual-facts");
      await expect(page.getByRole("heading", { name: "高级工具" })).toBeVisible();
      await expect(page.getByRole("link", { name: "录音转写" })).toHaveCount(0);

      await page.goto("/system/configuration");
      const systemNav = page.getByRole("navigation", { name: "系统中心" });
      await expect(systemNav.getByRole("link", { name: "集成与工具" })).toHaveCount(0);
      await expect(page.getByText("企微提取模型", { exact: true })).toHaveCount(0);

      await page.goto("/system/about");
      await expect(page.getByText("Core 版", { exact: true })).toBeVisible();
      await expect(page.getByText(/Core 不探测、不启动也不调用 FunASR、通义听悟、阿里云 ASR 或 WCG/)).toBeVisible();

      const pdfResponse = await request.post("/api/feedback/assessment-pdf", {
        multipart: { sessionCode: "" },
      });
      expect(pdfResponse.status()).toBe(400);
      expect(await pdfResponse.json()).toEqual({ error: "请先选择课次" });
    });

    let semesterId = "";
    let classId = "";
    let studentId = "";
    let sessionId = "";
    let sessionCode = "";
    let lessonId = "";
    let lessonMaterial: Record<string, unknown> = {};

    await test.step("从空库建立学期、班级和在读学生", async () => {
      const semesterResponse = await expectOk(await request.post("/api/semesters", { data: {
        name: "Core E2E 合成学期",
        startDate: "2099-01-01",
        endDate: "2099-06-30",
      } }));
      expect(semesterResponse.status()).toBe(201);
      semesterId = (await semesterResponse.json()).id;

      const classResponse = await expectOk(await request.post(`/api/semesters/${semesterId}/classes`, { data: {
        code: "CORE-E2E-01",
        name: "Core E2E 合成班",
      } }));
      expect(classResponse.status()).toBe(201);
      classId = (await classResponse.json()).id;

      const studentResponse = await expectOk(await request.post("/api/students", { data: {
        semesterId,
        classId,
        name: "合成学生甲",
        studentId: "CORE-E2E-STUDENT-01",
        gender: "女",
      } }));
      expect(studentResponse.status()).toBe(201);
      studentId = (await studentResponse.json()).id;
    });

    await test.step("导入学期公共材料，并按进度建议自动建立共同讲次草稿", async () => {
      const importResponse = await expectOk(await request.post("/api/feedback/script-library", { multipart: {
        semesterId,
        file: {
          name: "core-e2e-public-material.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          buffer: publicMaterialWorkbook(),
        },
      } }));
      const imported = await importResponse.json();
      expect(imported.library).toMatchObject({ name: "Core E2E 学期公共材料" });
      lessonMaterial = imported.library.entries[0].material;

      const groupResponse = await expectOk(await request.post(`/api/semesters/${semesterId}/class-groups`, { data: {
        name: "Core E2E 平行班组",
        classIds: [classId],
        leadClassId: classId,
      } }));
      expect(groupResponse.status()).toBe(201);

      const options = await expectOk(await request.get(
        `/api/semesters/${semesterId}/session?classId=${classId}&date=2099-02-01`,
      ));
      expect(await options.json()).toMatchObject({ recommendation: { type: "new", nextSequence: 1 } });

      const sessionResponse = await expectOk(await request.post(`/api/semesters/${semesterId}/session`, { data: {
        classId,
        date: "2099-02-01",
        requestKey: "core-e2e-session-create-1",
        groupProgressIntent: { type: "recommended" },
      } }));
      expect(sessionResponse.status()).toBe(201);
      const session = await sessionResponse.json();
      sessionId = session.id;
      sessionCode = session.code;
      lessonId = session.groupProgress.lesson.id;
      expect(session).toMatchObject({ studentCount: 1, groupProgress: { status: "created", lesson: { sequence: 1 } } });

      const groupsResponse = await expectOk(await request.get(`/api/semesters/${semesterId}/class-groups`));
      const draftLesson = (await groupsResponse.json()).groups[0].lessons[0];
      expect(draftLesson).toMatchObject({
        id: lessonId,
        title: "物质的量",
        revision: 0,
        confirmedAt: null,
        hasUnconfirmedChanges: true,
        material: { lessonTitle: "物质的量", semesterScriptSource: { lessonNumber: 1 } },
      });
    });

    await test.step("确认共同材料并录入一条普通课堂事实", async () => {
      const confirmation = await expectOk(await request.post(`/api/group-lessons/${lessonId}/confirm`));
      expect(await confirmation.json()).toMatchObject({ revision: { revision: 1 } });

      const groupsResponse = await expectOk(await request.get(`/api/semesters/${semesterId}/class-groups`));
      expect((await groupsResponse.json()).groups[0].lessons[0]).toMatchObject({
        revision: 1,
        hasUnconfirmedChanges: false,
        confirmedAt: expect.any(String),
      });

      const scoreResponse = await expectOk(await request.post("/api/quick-score", { data: {
        sessionCode,
        scores: [{ studentId, scoreA: 4, scoreB: 4, scoreC: 3, note: "能够说明物质的量换算步骤" }],
        attendances: [{ studentId, present: true }],
      } }));
      expect(await scoreResponse.json()).toEqual({ success: true, count: 1, attUpdated: 1 });
    });

    let planId = "";
    await test.step("生成、批准并导出一份 Core 反馈 Excel", async () => {
      const planResponse = await expectOk(await request.post("/api/report/feedback-plans", { data: {
        requestKey: "core-e2e-feedback-plan-1",
        displayName: "Core E2E 第一讲反馈",
        type: "event_micro",
        outputRequirement: "根据本讲已确认事实生成简洁反馈",
        generationMode: "fast",
        semesterId,
        classId,
        sessionId,
        studentIds: [studentId],
        lessonMaterial,
      } }));
      expect(planResponse.status()).toBe(201);
      planId = (await planResponse.json()).plan.id;

      const startResponse = await request.post(`/api/report/feedback-plans/${planId}`, { data: {
        action: "start_generation",
        generationMode: "fast",
        assessmentEvidence: {},
      } });
      expect(startResponse.status()).toBe(202);

      await expect.poll(async () => {
        const response = await expectOk(await request.get(`/api/report/feedback-plans/${planId}`));
        return (await response.json()).plan.status;
      }, { timeout: 60_000 }).toBe("in_review");

      const generatedResponse = await expectOk(await request.get(`/api/report/feedback-plans/${planId}`));
      const generated = (await generatedResponse.json()).plan;
      expect(generated.items).toHaveLength(1);
      expect(generated.items[0]).toMatchObject({ finalText: expect.any(String), finalTextHash: expect.any(String) });

      const approveResponse = await expectOk(await request.post(`/api/report/feedback-plans/${planId}`, { data: {
        action: "approve",
        itemIds: [generated.items[0].id],
        expectedHashes: { [generated.items[0].id]: generated.items[0].finalTextHash },
      } }));
      expect((await approveResponse.json()).plan.status).toBe("approved");

      const wecomExportResponse = await request.post(`/api/report/feedback-plans/${planId}`, { data: {
        action: "export_wecom_drafts",
      } });
      expect(wecomExportResponse.status()).toBe(404);
      expect(await wecomExportResponse.json()).toEqual(unavailablePayload);

      await page.goto(`/feedback?planId=${planId}&view=studio`);
      await expect(page.getByRole("heading", { name: "生成与复核" })).toBeVisible();
      await expect(page.getByRole("button", { name: "导出企微草稿 JSON" })).toHaveCount(0);

      const exportResponse = await expectOk(await request.post(`/api/report/feedback-plans/${planId}`, { data: {
        action: "export",
        mode: "complete",
      } }));
      expect(exportResponse.headers()["content-type"]).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const workbook = XLSX.read(await exportResponse.body(), { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["课后反馈"]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["姓名"]).toBe("合成学生甲");
    });

    await test.step("在同一隔离运行目录创建数据库备份", async () => {
      const backupResponse = await expectOk(await request.post("/api/system/archive"));
      const backup = await backupResponse.json();
      expect(backup).toMatchObject({
        success: true,
        fileName: expect.stringMatching(/^student-track_.*\.db$/),
        sizeBytes: expect.any(Number),
        rowCounts: { Semester: 1, Student: 1, ClassSession: 1 },
      });
      expect(backup.sizeBytes).toBeGreaterThan(0);
    });
  });
});
