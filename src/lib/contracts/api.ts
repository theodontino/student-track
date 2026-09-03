import { z } from "zod";

export const ApiErrorResponseSchema = z.object({
  error: z.string().min(1),
  code: z.string().min(1),
  retryable: z.boolean(),
  details: z.unknown().optional(),
  diagnosticId: z.string().min(1).optional(),
}).strict();

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
