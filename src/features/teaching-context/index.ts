// Keep this entry point type-only. Runtime hooks, UI components, and URL
// helpers are imported from their focused modules so Fast Refresh does not
// have to treat a mixed component/utility barrel as a rendering boundary.
export type { TeachingContext, SemesterSummary, SessionSummary, StudentSummary, ClassSummary } from "./types";
