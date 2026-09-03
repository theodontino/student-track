import os from "node:os";
import path from "node:path";

export const STUDENT_TRACK_DATA_ROOT_ENV = "STUDENT_TRACK_DATA_ROOT";
export const STUDENT_TRACK_RUNTIME_ROOT_ENV = "STUDENT_TRACK_RUNTIME_ROOT";
export const STUDENT_TRACK_ARCHIVES_ROOT_ENV = "STUDENT_TRACK_ARCHIVES_ROOT";

function configuredPath(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function defaultStudentTrackRuntimeRoot({
  platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
  homeDir = os.homedir(),
}: {
  platform?: NodeJS.Platform;
  localAppData?: string;
  homeDir?: string;
} = {}) {
  if (platform === "win32") {
    return path.join(localAppData?.trim() || path.join(homeDir, "AppData", "Local"), "Student Track");
  }
  return path.join(homeDir, "Library", "Application Support", "Student Track");
}

export function resolveStudentTrackRuntimePath(
  relativePath: string,
  componentOverrideEnv: string,
  legacyDefault: string,
) {
  const componentOverride = process.env[componentOverrideEnv]?.trim();
  if (componentOverride) return configuredPath(componentOverride);

  const configuredRoot = process.env[STUDENT_TRACK_RUNTIME_ROOT_ENV]?.trim();
  if (configuredRoot) return path.join(configuredPath(configuredRoot), relativePath);
  if (process.platform === "win32") return path.join(defaultStudentTrackRuntimeRoot(), relativePath);
  return legacyDefault;
}

export function resolveStudentTrackDataPath(
  relativePath: string,
  componentOverrideEnv: string,
) {
  const componentOverride = process.env[componentOverrideEnv]?.trim();
  if (componentOverride) return configuredPath(componentOverride);

  const configuredRoot = process.env[STUDENT_TRACK_DATA_ROOT_ENV]?.trim();
  if (configuredRoot) return path.join(configuredPath(configuredRoot), relativePath);

  const runtimeRoot = process.env[STUDENT_TRACK_RUNTIME_ROOT_ENV]?.trim();
  if (runtimeRoot) return path.join(configuredPath(runtimeRoot), "data", relativePath);
  if (process.platform === "win32") return path.join(defaultStudentTrackRuntimeRoot(), "data", relativePath);

  return path.join(process.cwd(), "data", relativePath);
}

export function resolveStudentTrackArchiveRoot() {
  return resolveStudentTrackRuntimePath(
    "archives",
    STUDENT_TRACK_ARCHIVES_ROOT_ENV,
    path.join(process.cwd(), "archives"),
  );
}
