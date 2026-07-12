import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertSafeTestDatabaseUrl,
  assertSafeTestDirectory,
  TEST_TEMP_PREFIX,
} from "../../scripts/test-environment";

describe("isolated test environment safety", () => {
  it("accepts only the dedicated test database under a prefixed system temp directory", () => {
    const directory = path.join(os.tmpdir(), `${TEST_TEMP_PREFIX}fixture`);
    const url = pathToFileURL(path.join(directory, "test.db")).href;

    expect(assertSafeTestDirectory(directory)).toBe(path.resolve(directory));
    expect(assertSafeTestDatabaseUrl(url)).toBe(path.resolve(directory, "test.db"));
  });

  it("rejects the project database and unrelated temp paths", () => {
    expect(() => assertSafeTestDatabaseUrl(pathToFileURL(path.join(process.cwd(), "dev.db")).href))
      .toThrow("unsafe test directory");
    expect(() => assertSafeTestDatabaseUrl(pathToFileURL(path.join(os.tmpdir(), "unrelated", "test.db")).href))
      .toThrow("unsafe test directory");
    expect(() => assertSafeTestDatabaseUrl("https://example.test/test.db"))
      .toThrow("file: protocol");
  });
});
