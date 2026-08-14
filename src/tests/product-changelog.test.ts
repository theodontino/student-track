import { describe, expect, it } from "vitest";
import packageMetadata from "../../package.json";
import { PRODUCT_CHANGELOG } from "@/lib/product-changelog";

describe("product changelog", () => {
  it("starts with the current application version", () => {
    expect(PRODUCT_CHANGELOG[0]?.version).toBe(packageMetadata.version);
  });

  it("keeps version entries unique and meaningful", () => {
    expect(new Set(PRODUCT_CHANGELOG.map((entry) => entry.version)).size).toBe(PRODUCT_CHANGELOG.length);
    expect(PRODUCT_CHANGELOG.every((entry) => entry.title.trim() && entry.changes.length > 0)).toBe(true);
  });
});
