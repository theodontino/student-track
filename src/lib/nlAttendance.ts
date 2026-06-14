import type { ParseResult, ParsedStudent } from "@/lib/parser";

export interface ClassStudent {
  id: string;
  name: string;
}

/**
 * Expands an NL parse result to the selected class roster. Mentioned students
 * are marked present; every roster student not mentioned is added as absent
 * with no inferred scores, events, or communication.
 */
export function completeClassAttendance(
  parsed: ParseResult,
  roster: ClassStudent[]
): ParseResult {
  const byName = new Map<string, ParsedStudent>();
  for (const student of parsed.students) {
    if (!byName.has(student.name)) byName.set(student.name, student);
  }

  return {
    ...parsed,
    students: roster.map((student) => {
      const mentioned = byName.get(student.name);
      if (mentioned) return { ...mentioned, present: true };
      return {
        name: student.name,
        scores: { A: null, B: null, C: null },
        events: [],
        communication: null,
        present: false,
      };
    }),
  };
}
