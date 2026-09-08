import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackRequestCapacity } from "@/services/feedback-plan/generation-capacity";

afterEach(() => vi.useRealTimers());

describe("feedback request capacity", () => {
  it("starts at one and increases only after a healthy capacity-sized window", async () => {
    const pool = new FeedbackRequestCapacity();
    await pool.run("provider", async () => "ok");
    expect(pool.snapshot().providers[0].capacity).toBe(2);
    await pool.run("provider", async () => "ok");
    expect(pool.snapshot().providers[0].capacity).toBe(2);
    await pool.run("provider", async () => "ok");
    expect(pool.snapshot().providers[0].capacity).toBe(3);
  });

  it("halves on overload and retries only this model call twice at most", async () => {
    vi.useFakeTimers();
    const pool = new FeedbackRequestCapacity();
    for (let index = 0; index < 6; index++) await pool.run("p", async () => null);
    expect(pool.snapshot().providers[0].capacity).toBe(4);
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("overloaded"), { status: 429, headers: new Headers({ "retry-after": "12" }) }));
    const settled = pool.run("p", request).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.snapshot().providers[0]).toMatchObject({ capacity: 2, active: 0, waiting: 1, cooldownMs: 12000 });
    await vi.runAllTimersAsync();
    expect(await settled).toMatchObject({ status: 429 });
    expect(request).toHaveBeenCalledTimes(3);
    expect(pool.snapshot().active).toBe(0);
  });

  it("does not let late successes from the old capacity window undo a reduction", async () => {
    vi.useFakeTimers();
    const pool = new FeedbackRequestCapacity();
    for (let index = 0; index < 6; index++) await pool.run("p", async () => null);
    const controller = new AbortController();
    const failed = pool.run("p", async () => { throw Object.assign(new Error("overload"), { status: 429 }); }, controller.signal).catch((error) => error);
    const releases: Array<() => void> = [];
    const oldRequests = Promise.all([1, 2].map(() => pool.run("p", () => new Promise<void>((resolve) => releases.push(resolve)))));
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.snapshot().providers[0].capacity).toBe(2);
    controller.abort();
    releases.forEach((release) => release());
    await Promise.all([failed, oldRequests]);
    expect(pool.snapshot().providers[0].capacity).toBe(2);
  });

  it("waits for two timeouts without a success before reducing capacity", async () => {
    vi.useFakeTimers();
    const pool = new FeedbackRequestCapacity();
    for (let index = 0; index < 6; index++) await pool.run("p", async () => null);
    const timeout = Object.assign(new Error("request timed out"), { name: "APIConnectionTimeoutError" });
    const request = vi.fn().mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockResolvedValue("ok");
    const result = pool.run("p", request);
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.snapshot().providers[0].capacity).toBe(4);
    await vi.runAllTimersAsync();
    expect(await result).toBe("ok");
    expect(pool.snapshot().providers[0].capacity).toBe(2);
  });

  it("does not retry authentication or content errors", async () => {
    const pool = new FeedbackRequestCapacity();
    for (const error of [Object.assign(new Error("unauthorized"), { status: 401 }), new Error("schema invalid")]) {
      const request = vi.fn().mockRejectedValue(error);
      await expect(pool.run("p", request)).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(1);
    }
    expect(pool.snapshot().providers[0].capacity).toBe(1);
  });

  it("aborts a cooldown waiter without starting another HTTP attempt", async () => {
    vi.useFakeTimers();
    const pool = new FeedbackRequestCapacity();
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValue(Object.assign(new Error("busy"), { status: 503 }));
    const result = pool.run("p", request, controller.signal).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await result;
    await vi.runAllTimersAsync();
    expect(request).toHaveBeenCalledTimes(1);
    expect(pool.snapshot().active).toBe(0);
    expect(pool.snapshot().providers[0].waiting).toBe(0);
  });

  it("keeps a shared hard maximum across providers", async () => {
    const pool = new FeedbackRequestCapacity();
    for (const provider of ["a", "b"]) for (let index = 0; index < 1225; index++) await pool.run(provider, async () => null);
    const releases: Array<() => void> = [];
    const controller = new AbortController();
    const results = Promise.allSettled(Array.from({ length: 80 }, (_, index) => pool.run(index % 2 ? "a" : "b", () => new Promise<void>((resolve) => releases.push(resolve)), controller.signal)));
    await Promise.resolve();
    expect(releases).toHaveLength(50);
    expect(pool.snapshot().active).toBe(50);
    controller.abort();
    releases.forEach((release) => release());
    await results;
    expect(pool.snapshot().active).toBe(0);
  });

  it("processes 80 controlled requests faster than fixed concurrency two", async () => {
    vi.useFakeTimers();
    const pool = new FeedbackRequestCapacity();
    const start = Date.now();
    let peak = 0;
    const work = Promise.all(Array.from({ length: 80 }, () => pool.run("p", async () => {
      peak = Math.max(peak, pool.snapshot().active);
      await new Promise((resolve) => setTimeout(resolve, 100));
    })));
    await vi.runAllTimersAsync();
    await work;
    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThanOrEqual(50);
    expect(Date.now() - start).toBeLessThan(4000);
  });
});
