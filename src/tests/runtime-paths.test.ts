import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultStudentTrackRuntimeRoot,
  resolveStudentTrackArchiveRoot,
  resolveStudentTrackDataPath,
  resolveStudentTrackRuntimePath,
  STUDENT_TRACK_ARCHIVES_ROOT_ENV,
  STUDENT_TRACK_DATA_ROOT_ENV,
  STUDENT_TRACK_RUNTIME_ROOT_ENV,
} from "@/lib/runtime-paths";

beforeEach(() => {
  vi.stubEnv(STUDENT_TRACK_DATA_ROOT_ENV, "");
  vi.stubEnv(STUDENT_TRACK_RUNTIME_ROOT_ENV, "");
  vi.stubEnv(STUDENT_TRACK_ARCHIVES_ROOT_ENV, "");
  vi.stubEnv("STUDENT_TRACK_FEEDBACK_INBOX_ROOT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Student Track data paths", () => {
  it("uses the platform data directory by default", () => {
    const expectedRoot = process.platform === "win32"
      ? path.join(defaultStudentTrackRuntimeRoot(), "data")
      : path.join(process.cwd(), "data");
    expect(resolveStudentTrackDataPath("llm-cache", "LLM_CACHE_ROOT"))
      .toBe(path.join(expectedRoot, "llm-cache"));
  });

  it("uses the shared data root when configured", () => {
    vi.stubEnv(STUDENT_TRACK_DATA_ROOT_ENV, "/tmp/student-track-data");
    expect(resolveStudentTrackDataPath("diarize", "TEST_COMPONENT_DATA_ROOT"))
      .toBe(path.join("/tmp/student-track-data", "diarize"));
  });

  it("keeps component-specific overrides at the highest priority", () => {
    vi.stubEnv(STUDENT_TRACK_DATA_ROOT_ENV, "/tmp/student-track-data");
    vi.stubEnv("LLM_SETTINGS_PATH", "/tmp/specific/settings.json");
    expect(resolveStudentTrackDataPath("llm-settings.json", "LLM_SETTINGS_PATH"))
      .toBe("/tmp/specific/settings.json");
  });

  it("resolves relative configured paths from the current working directory", () => {
    vi.stubEnv(STUDENT_TRACK_DATA_ROOT_ENV, "portable-data");
    expect(resolveStudentTrackDataPath("llm-cache", "TEST_COMPONENT_DATA_ROOT"))
      .toBe(path.join(process.cwd(), "portable-data", "llm-cache"));
  });

  it("places the Windows runtime under LocalAppData", () => {
    expect(defaultStudentTrackRuntimeRoot({
      platform: "win32",
      localAppData: "C:\\Users\\Example\\AppData\\Local",
      homeDir: "C:\\Users\\Example",
    })).toBe(path.join("C:\\Users\\Example\\AppData\\Local", "Student Track"));
  });

  it("uses the shared runtime root for private sibling directories", () => {
    vi.stubEnv(STUDENT_TRACK_RUNTIME_ROOT_ENV, "/tmp/student-track-runtime");
    expect(resolveStudentTrackRuntimePath(
      "feedback-inbox",
      "STUDENT_TRACK_FEEDBACK_INBOX_ROOT",
      "/legacy/inbox",
    )).toBe(path.join("/tmp/student-track-runtime", "feedback-inbox"));
    expect(resolveStudentTrackDataPath("llm-cache", "LLM_CACHE_ROOT"))
      .toBe(path.join("/tmp/student-track-runtime", "data", "llm-cache"));
  });

  it("keeps an explicit archives directory above the shared runtime root", () => {
    vi.stubEnv(STUDENT_TRACK_RUNTIME_ROOT_ENV, "/tmp/student-track-runtime");
    vi.stubEnv(STUDENT_TRACK_ARCHIVES_ROOT_ENV, "/tmp/student-track-archives");
    expect(resolveStudentTrackArchiveRoot()).toBe("/tmp/student-track-archives");
  });
});
