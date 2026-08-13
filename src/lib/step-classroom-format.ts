export const STEP_CLASSROOM_HEADER_V1 = "STEP_CLASSROOM_EXPORT_V1";
export const STEP_CLASSROOM_HEADER_V2 = "STEP_CLASSROOM_EXPORT_V2";

export type StepClassroomExportVersion = 1 | 2;

export function detectStepClassroomExportVersion(rawText: string): StepClassroomExportVersion | null {
  const text = rawText.replace(/^\uFEFF/, "").trim();
  if (text.startsWith(`${STEP_CLASSROOM_HEADER_V1}\n`)) return 1;
  if (text.startsWith(`${STEP_CLASSROOM_HEADER_V2}\n`)) return 2;
  return null;
}

export function isStepClassroomExport(rawText: string): boolean {
  return detectStepClassroomExportVersion(rawText) !== null;
}
