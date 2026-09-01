import { z } from "zod";

const id = z.string().trim().min(1).max(200);

export const SessionCreationRequestKeySchema = z.string().trim().min(8).max(200);

export const GroupProgressIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recommended") }),
  z.object({ type: z.literal("independent") }),
  z.object({ type: z.literal("lesson"), groupLessonId: id }),
]);

export type GroupProgressIntent = z.infer<typeof GroupProgressIntentSchema>;

export interface SessionCreationLessonOption {
  id: string;
  title: string;
  sequence: number;
  started: boolean;
  linkedClasses: Array<{
    id: string;
    code: string;
    name: string | null;
    sessionId: string;
    sessionDate: string;
  }>;
}

export type SessionCreationRecommendation =
  | { type: "independent"; reason: string }
  | { type: "existing"; reason: string; lesson: Pick<SessionCreationLessonOption, "id" | "title" | "sequence"> }
  | { type: "new"; reason: string; nextSequence: number }
  | { type: "choice_required"; reason: string }
  | { type: "waiting"; reason: string };

export interface SessionCreationOptions {
  date: string;
  class: { id: string; code: string; name: string | null } | null;
  group: {
    id: string;
    name: string;
    leadClass: { id: string; code: string; name: string | null } | null;
    isLeadClass: boolean;
  } | null;
  lessons: SessionCreationLessonOption[];
  recommendation: SessionCreationRecommendation;
}
