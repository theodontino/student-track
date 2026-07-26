import { describe, expect, it } from "vitest";
import { TtlLruCache } from "@/lib/ttl-lru-cache";

describe("TtlLruCache", () => {
  it("expires entries without a timer and evicts the least recently used", () => {
    const cache = new TtlLruCache<string, number>({ ttlMs: 10, maxEntries: 2 });
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    expect(cache.get("a", 1)).toBe(1);
    cache.set("c", 3, 2);
    expect(cache.get("b", 3)).toBeUndefined();
    expect(cache.get("a", 3)).toBe(1);
    expect(cache.get("a", 11)).toBeUndefined();
  });
});
