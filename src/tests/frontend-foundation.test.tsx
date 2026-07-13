import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog, Drawer } from "@/components/ui";
import { entryReducer } from "@/features/entry/entry-reducer";
import { ApiError, requestJson } from "@/lib/api-client";
import { SemesterContextSelector } from "@/features/teaching-context";

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

  it("renders the shared semester-only context selector", () => {
    const selector = renderToStaticMarkup(<SemesterContextSelector value="" onChange={() => undefined} />);
    expect(selector).toContain("查看学期");
    expect(selector).toContain("当前学期");
    expect(selector).not.toContain("选择班级");
  });

  it("returns typed JSON and normalizes API failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })).mockResolvedValueOnce(new Response(JSON.stringify({ error: "固定错误" }), { status: 422, headers: { "Content-Type": "application/json" } })));
    await expect(requestJson<{ ok: boolean }>("/ok")).resolves.toEqual({ ok: true });
    await expect(requestJson("/fail")).rejects.toEqual(expect.objectContaining<ApiError>({ name: "ApiError", status: 422, message: "固定错误" }));
  });
});
