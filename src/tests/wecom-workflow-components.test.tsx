import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import WeComCatchPanel from "@/components/wecom/WeComCatchPanel";

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
});
