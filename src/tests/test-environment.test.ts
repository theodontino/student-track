import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertSafeTestDatabaseUrl,
  assertSafeTestDirectory,
  createIsolatedTestEnvironment,
  removeIsolatedTestEnvironment,
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

  it("keeps every E2E runtime directory inside its disposable root", () => {
    const environment = createIsolatedTestEnvironment();
    try {
      expect(environment.env.STUDENT_TRACK_RUNTIME_ROOT).toBe(environment.rootDir);
      for (const variable of [
        "STUDENT_TRACK_DATA_ROOT",
        "STUDENT_TRACK_ARCHIVES_ROOT",
        "STUDENT_TRACK_FEEDBACK_ATTACHMENTS_ROOT",
        "STUDENT_TRACK_FEEDBACK_INBOX_ROOT",
      ]) {
        expect(path.dirname(environment.env[variable]!)).toBe(environment.rootDir);
      }
    } finally {
      removeIsolatedTestEnvironment(environment.rootDir);
    }
  });

  it("propagates the selected build edition to code running inside isolated tests", () => {
    const previousEdition = process.env.STUDENT_TRACK_EDITION;
    const previousPublicEdition = process.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION;
    process.env.STUDENT_TRACK_EDITION = "core";
    process.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION = "full";

    const environment = createIsolatedTestEnvironment();
    try {
      expect(environment.env.STUDENT_TRACK_EDITION).toBe("core");
      expect(environment.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION).toBe("core");
    } finally {
      removeIsolatedTestEnvironment(environment.rootDir);
      if (previousEdition === undefined) delete process.env.STUDENT_TRACK_EDITION;
      else process.env.STUDENT_TRACK_EDITION = previousEdition;
      if (previousPublicEdition === undefined) delete process.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION;
      else process.env.NEXT_PUBLIC_STUDENT_TRACK_EDITION = previousPublicEdition;
    }
  });
});
