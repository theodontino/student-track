import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog, Dialog, Drawer, FormField, Input, MetricCard, SaveStateIndicator, Skeleton } from "@/components/ui";
import { entryReducer, INITIAL_ENTRY_STATE } from "@/features/entry/entry-reducer";
import { ApiError, downloadFile, requestJson } from "@/lib/api-client";

afterEach(() => vi.unstubAllGlobals());

describe("frontend foundation", () => {
  it("moves the entry reducer between explicit steps", () => {
    expect(entryReducer(INITIAL_ENTRY_STATE, { type: "set-step", step: "review" })).toMatchObject({ step: "review" });
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
    await expect(requestJson("/fail")).rejects.toEqual(expect.objectContaining<ApiError>({
      name: "ApiError",
      status: 422,
      message: "固定错误",
      code: "internal_error",
      retryable: false,
    }));
  });

  it("handles empty success responses and plain-text API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(new Response(" 服务暂时不可用 ", { status: 503 })),
    );

    await expect(requestJson<void>("/empty")).resolves.toBeUndefined();
    await expect(requestJson("/text-failure")).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: "ApiError",
        status: 503,
        message: "服务暂时不可用",
        code: "internal_error",
        retryable: false,
      }),
    );
  });

  it("downloads successful responses with the requested filename", async () => {
    const click = vi.fn();
    const anchor = { href: "", download: "", click };
    const createObjectURL = vi.fn(() => "blob:download");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("report", { status: 200 })));
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    await downloadFile("/report", "课堂报告.xlsx");

    expect(anchor).toMatchObject({ href: "blob:download", download: "课堂报告.xlsx" });
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });
});
