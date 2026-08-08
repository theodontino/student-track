import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveStudentTrackDataPath,
  STUDENT_TRACK_DATA_ROOT_ENV,
} from "@/lib/runtime-paths";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Student Track data paths", () => {
  it("preserves the existing project data directory by default", () => {
    expect(resolveStudentTrackDataPath("llm-cache", "LLM_CACHE_ROOT"))
      .toBe(path.join(process.cwd(), "data", "llm-cache"));
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
});
