/** One launch reservation closes the race before the first database await. */
export class FeedbackPlanLane {
  private launching: string | null = null;
  private previousPlanId: string | null = null;

  async launch<T>(planId: string, activePlanIds: Iterable<string>, operation: () => Promise<T>, onNewPlan: () => void) {
    if (this.launching !== null || [...activePlanIds].some((id) => id !== planId)) {
      throw new Error("feedback_plan_busy");
    }
    this.launching = planId;
    try {
      if (this.previousPlanId !== planId) {
        onNewPlan();
        this.previousPlanId = planId;
      }
      return await operation();
    } finally {
      this.launching = null;
    }
  }
}
