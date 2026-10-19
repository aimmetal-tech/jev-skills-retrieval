import type { TimingState } from "./protocol.ts";

export type Activity = "work" | "queue" | "backoff" | "cooldown";
export class TrialClock {
  private activity: Activity = "work";
  private route = false;
  private last = performance.now();
  readonly state: TimingState;
  constructor(
    saved?: TimingState,
    private now = () => performance.now(),
  ) {
    this.last = now();
    this.state = saved
      ? { ...saved, resumes: saved.resumes + 1 }
      : {
          workMs: 0,
          queueMs: 0,
          backoffMs: 0,
          cooldownMs: 0,
          onlineMs: 0,
          routeWorkMs: 0,
          naturalStartedAt: new Date().toISOString(),
          savedAt: new Date().toISOString(),
          resumes: 0,
        };
  }
  snapshot() {
    const at = this.now();
    const delta = Math.max(0, at - this.last);
    this.last = at;
    this.state.onlineMs += delta;
    const key = `${this.activity}Ms` as
      | "workMs"
      | "queueMs"
      | "backoffMs"
      | "cooldownMs";
    this.state[key] += delta;
    if (this.route && this.activity === "work") this.state.routeWorkMs += delta;
    this.state.savedAt = new Date().toISOString();
    return { ...this.state };
  }
  set(activity: Activity) {
    this.snapshot();
    this.activity = activity;
  }
  routing(active: boolean) {
    this.snapshot();
    this.route = active;
  }
}
