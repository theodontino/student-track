import { z } from "zod";

export const SYSTEM_API_VERSION = "v1" as const;
export const SYSTEM_CAPABILITIES = ["system.health.v1"] as const;

export const SystemHealthResponseSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal("student-track"),
  appVersion: z.string().min(1).max(40),
  apiVersion: z.literal(SYSTEM_API_VERSION),
  status: z.literal("ok"),
  capabilities: z.array(z.enum(SYSTEM_CAPABILITIES)),
}).strict();

export type SystemHealthResponse = z.infer<typeof SystemHealthResponseSchema>;
