import { describe, expect, it } from "vitest";
import { readSSEStream } from "@/lib/sse";

describe("readSSEStream", () => {
  it("propagates callback errors from residual buffered event", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({
          type: "error",
          message: "tail error",
        })));
        controller.close();
      },
    });

    await expect(readSSEStream(stream.getReader(), (event) => {
      if (event.type === "error") throw new Error(event.message);
    })).rejects.toThrow("tail error");
  });
});
