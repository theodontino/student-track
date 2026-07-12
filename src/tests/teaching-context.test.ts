import { describe, expect, it } from "vitest";
import { applyTeachingContext, parseTeachingContext } from "@/features/teaching-context/url-context";

describe("teaching context URL", () => {
  it("reads the stable query parameter names", () => {
    expect(parseTeachingContext("?semesterId=sem-1&class=高一A班&sessionCode=S03")).toEqual({ semesterId: "sem-1", className: "高一A班", sessionCode: "S03" });
  });
  it("updates context without dropping unrelated parameters", () => {
    const url = applyTeachingContext(new URL("http://127.0.0.1:3000/entry?step=review&class=old"), { semesterId: "sem-2", className: "", sessionCode: "" });
    expect(url.searchParams.get("step")).toBe("review");
    expect(url.searchParams.get("semesterId")).toBe("sem-2");
    expect(url.searchParams.has("class")).toBe(false);
  });
});
