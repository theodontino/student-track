import path from "node:path";

export const STUDENT_TRACK_DATA_ROOT_ENV = "STUDENT_TRACK_DATA_ROOT";

function configuredPath(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

export function resolveStudentTrackDataPath(
  relativePath: string,
  componentOverrideEnv: string,
) {
  const componentOverride = process.env[componentOverrideEnv]?.trim();
  if (componentOverride) return configuredPath(componentOverride);

  const configuredRoot = process.env[STUDENT_TRACK_DATA_ROOT_ENV]?.trim();
  if (configuredRoot) return path.join(configuredPath(configuredRoot), relativePath);

  return path.join(process.cwd(), "data", relativePath);
}
