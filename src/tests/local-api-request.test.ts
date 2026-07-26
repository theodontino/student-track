import { describe, expect, it } from "vitest";
import { isAllowedLocalApiRequest, isLoopbackHost } from "@/lib/local-api-request";

describe("local API request boundary", () => {
  it("accepts localhost and loopback same-origin requests", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isAllowedLocalApiRequest({
      requestOrigin: "http://127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      secFetchSite: "same-origin",
      host: "127.0.0.1:3000",
    })).toBe(true);
  });

  it("rejects external host, foreign origin and cross-site fetch", () => {
    expect(isAllowedLocalApiRequest({ requestOrigin: "https://example.com", host: "example.com" })).toBe(false);
    expect(isAllowedLocalApiRequest({
      requestOrigin: "http://127.0.0.1:3000",
      origin: "http://localhost:3001",
      host: "127.0.0.1:3000",
    })).toBe(false);
    expect(isAllowedLocalApiRequest({
      requestOrigin: "http://127.0.0.1:3000",
      origin: "http://localhost:3000",
      host: "127.0.0.1:3000",
    })).toBe(false);
    expect(isAllowedLocalApiRequest({
      requestOrigin: "http://127.0.0.1:3000",
      secFetchSite: "cross-site",
      host: "127.0.0.1:3000",
    })).toBe(false);
    expect(isAllowedLocalApiRequest({
      requestOrigin: "http://127.0.0.1:3000",
      secFetchSite: "same-site",
      host: "127.0.0.1:3000",
    })).toBe(false);
  });
});
