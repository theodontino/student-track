import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import LocalToolStatusPanel from "@/components/system/LocalToolStatusPanel";

describe("LocalToolStatusPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the cloud upload notice without starting a check during server render", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToString(<LocalToolStatusPanel />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("本地工具状态");
    expect(html).toContain("音频可能上传到云端");
    expect(html).toContain("通义听悟");
    expect(html).toContain("阿里云 ASR");
  });
});
