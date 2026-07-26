import { z } from "zod";

const task = z.object({
  id: z.string().min(1),
  title: z.string(),
  engine: z.enum(["auto", "local", "tingwu"]),
  speakerCount: z.number().int().nullable(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  inputFileName: z.string(),
  retryOf: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  hasResultText: z.boolean(),
  hasResultJson: z.boolean(),
  resultText: z.string().optional(),
  log: z.string().optional(),
});

export const DiarizeStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("created"), task }),
  z.object({ type: z.literal("task"), task }),
  z.object({ type: z.literal("log"), stream: z.enum(["stdout", "stderr"]), content: z.string() }),
  z.object({ type: z.literal("done"), task }),
  z.object({ type: z.literal("error"), message: z.string().min(1), task: task.optional() }),
]);

export type DiarizeStreamEvent = z.infer<typeof DiarizeStreamEventSchema>;
