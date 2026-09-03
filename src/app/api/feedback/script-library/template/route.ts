import { createFeedbackScriptLibraryTemplate } from "@/services/feedback-script-library-service";

export async function GET() {
  const workbook = createFeedbackScriptLibraryTemplate();
  return new Response(workbook, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="semester-common-material-template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
