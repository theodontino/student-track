import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog, Dialog, Drawer, FormField, Input, MetricCard, SaveStateIndicator, Skeleton } from "@/components/ui";
import { entryReducer } from "@/features/entry/entry-reducer";
import { ApiError, requestJson } from "@/lib/api-client";

afterEach(() => vi.unstubAllGlobals());

describe("frontend foundation", () => {
  it("moves the entry reducer between explicit steps", () => {
    expect(entryReducer({ step: "input" }, { type: "set-step", step: "review" })).toEqual({ step: "review" });
  });

  it("renders accessible dialog and drawer semantics", () => {
    const dialog = renderToStaticMarkup(<Dialog open title="确认操作" onClose={() => undefined}><p>正文</p></Dialog>);
    const drawer = renderToStaticMarkup(<Drawer open title="筛选" onClose={() => undefined}><p>内容</p></Drawer>);
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(drawer).toContain("ui-overlay__panel--drawer");
  });

  it("renders shared form, metric, loading, save, and confirmation patterns", () => {
    const field = renderToStaticMarkup(<FormField id="student-name" label="姓名" required error="请输入姓名"><Input id="student-name" aria-invalid="true" /></FormField>);
    const metric = renderToStaticMarkup(<MetricCard label="本学期综合分" value="82" detail="评价 4 次" tone="brand" />);
    const states = renderToStaticMarkup(<><Skeleton /><SaveStateIndicator state="dirty" /></>);
    const confirm = renderToStaticMarkup(<ConfirmDialog open title="删除课次" description="删除后无法恢复。" danger onConfirm={() => undefined} onClose={() => undefined} />);
    expect(field).toContain('for="student-name"');
    expect(field).toContain('role="alert"');
    expect(metric).toContain("ui-metric--brand");
    expect(states).toContain("有未保存修改");
    expect(confirm).toContain("删除课次");
    expect(confirm).toContain("ui-button--danger");
  });

  it("returns typed JSON and normalizes API failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })).mockResolvedValueOnce(new Response(JSON.stringify({ error: "固定错误" }), { status: 422, headers: { "Content-Type": "application/json" } })));
    await expect(requestJson<{ ok: boolean }>("/ok")).resolves.toEqual({ ok: true });
    await expect(requestJson("/fail")).rejects.toEqual(expect.objectContaining<ApiError>({ name: "ApiError", status: 422, message: "固定错误" }));
  });
});
