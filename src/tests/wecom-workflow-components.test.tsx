import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import WeComCatchPanel from "@/components/wecom/WeComCatchPanel";
import WeComAutoImportPanel from "@/components/wecom/WeComAutoImportPanel";
import WeComRollbackPanel from "@/features/wecom/WeComRollbackPanel";
import LLMCachePanel from "@/features/system/LLMCachePanel";

describe("wecom workflow components", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not call WeComCatch APIs, including sync-start, just by rendering", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToString(<WeComCatchPanel />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("启动同步");
  });

  it("renders the one-click import without starting network work", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToString(<WeComAutoImportPanel />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("一键同步并导入");
    expect(html).toContain("未处理的新消息");
  });

  it("renders import status and rollback controls without calling the API during SSR", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToString(<WeComRollbackPanel />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("企微导入记录与回滚");
    expect(html).toContain("按日期回滚");
    expect(html).toContain("已读未写");
  });

  it("renders safe LLM cache maintenance controls without calling the API during SSR", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToString(<LLMCachePanel />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("LLM 本机缓存");
    expect(html).toContain("正文需在本机目录查看");
    expect(html).toContain("ui-button--warning");
    expect(html).not.toContain("ui-button--danger");
  });
});
