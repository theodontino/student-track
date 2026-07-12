import type { TeachingContext } from "./types";

export const emptyTeachingContext: TeachingContext = { semesterId: "", className: "", sessionCode: "" };

export function parseTeachingContext(search: string): TeachingContext {
  const params = new URLSearchParams(search);
  return { semesterId: params.get("semesterId") ?? "", className: params.get("class") ?? "", sessionCode: params.get("sessionCode") ?? "" };
}

export function applyTeachingContext(url: URL, context: TeachingContext): URL {
  const next = new URL(url);
  const values: Array<[string, string]> = [["semesterId", context.semesterId], ["class", context.className], ["sessionCode", context.sessionCode]];
  for (const [key, value] of values) {
    if (value) next.searchParams.set(key, value);
    else next.searchParams.delete(key);
  }
  return next;
}
