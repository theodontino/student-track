import { expect, it, vi } from "vitest";
import { FeedbackPlanLane } from "@/services/feedback-plan/generation-lane";

it("reserves a plan before awaiting preparation and blocks a racing second plan", async () => {
  const lane = new FeedbackPlanLane();
  const reset = vi.fn();
  let finish!: () => void;
  const first = lane.launch("first", [], () => new Promise<void>((resolve) => { finish = resolve; }), reset);
  const second = vi.fn();
  await expect(lane.launch("second", [], second, reset)).rejects.toThrow("feedback_plan_busy");
  expect(second).not.toHaveBeenCalled();
  finish(); await first;
  await expect(lane.launch("second", ["first"], second, reset)).rejects.toThrow("feedback_plan_busy");
  await lane.launch("second", [], async () => null, reset);
  expect(reset).toHaveBeenCalledTimes(2);
});

it("keeps learned capacity on resume but releases a failed launch reservation", async () => {
  const lane = new FeedbackPlanLane();
  const reset = vi.fn();
  await expect(lane.launch("first", [], async () => { throw new Error("database failed"); }, reset)).rejects.toThrow("database failed");
  await lane.launch("first", [], async () => null, reset);
  expect(reset).toHaveBeenCalledTimes(1);
});
