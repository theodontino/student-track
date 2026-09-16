import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async () => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ recordDiagnosticFailure }, { createDiagnosticId }] = await Promise.all([
    import("@/lib/diagnostics"),
    import("@/lib/api-error-core"),
  ]);
  await recordDiagnosticFailure({
    diagnosticId: createDiagnosticId(),
    source: "server.unhandled",
    status: 500,
    code: "unhandled_server_error",
    retryable: false,
  });
};
