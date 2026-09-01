import { z } from "zod";
import { LessonFeedbackMaterialSchema } from "@/lib/contracts/feedback";

const id = z.string().trim().min(1).max(200);
const uniqueIds = z.array(id).min(1).max(50).superRefine((items, ctx) => {
  if (new Set(items).size !== items.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "班级不能重复" });
  }
});

export const ClassGroupWriteSchema = z.object({
  name: z.string().trim().min(1).max(100),
  classIds: uniqueIds,
  leadClassId: id,
}).superRefine((value, ctx) => {
  if (!value.classIds.includes(value.leadClassId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["leadClassId"], message: "进度基准班必须属于当前班级组" });
  }
});

export const GroupLessonCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sequence: z.number().int().min(1).max(1000),
  material: LessonFeedbackMaterialSchema,
});

export const GroupLessonUpdateSchema = GroupLessonCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "至少提供一项共同课修改" },
);

export const GROUP_LESSON_SYNC_STATUSES = [
  "synced",
  "partially_synced",
  "diverged",
  "not_applicable",
] as const;

export const GroupLessonSessionWriteSchema = z.object({
  sessionId: id,
  syncStatus: z.enum(GROUP_LESSON_SYNC_STATUSES),
  differenceSummary: z.string().trim().max(2000).optional(),
  comparable: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (value.syncStatus !== "synced" && !value.differenceSummary) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["differenceSummary"], message: "非完全同步课次需要填写差异说明" });
  }
});

export type ClassGroupWriteInput = z.infer<typeof ClassGroupWriteSchema>;
export type GroupLessonCreateInput = z.infer<typeof GroupLessonCreateSchema>;
export type GroupLessonUpdateInput = z.infer<typeof GroupLessonUpdateSchema>;
export type GroupLessonSessionWriteInput = z.infer<typeof GroupLessonSessionWriteSchema>;
