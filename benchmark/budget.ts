import type { Limits } from "./types.ts";

/** Token stop is checked at response boundaries; one in-flight response can overshoot. */
export class Budget {
  requests = 0;
  tokens = 0;
  stopped: string | undefined;
  constructor(readonly limits: Limits) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("Limits must be positive integers");
    }
  }
  check() {
    if (this.stopped) throw new Error("benchmark_budget_stopped");
    if (
      this.requests >= this.limits.maxRequests ||
      this.tokens >= this.limits.maxTotalTokens
    ) {
      this.stopped = "limit_reached";
      throw new Error("benchmark_budget_stopped");
    }
  }
  account(tokens: number | null) {
    if (tokens === null) this.stopped ??= "unknown_usage";
    else this.tokens += tokens;
  }
  fetch(
    transport: typeof fetch = fetch,
    onResponse?: (status: number) => void,
  ): typeof fetch {
    return async (input, init) => {
      this.check();
      this.requests++;
      // Do not hide extra redirected requests behind a single transport reservation.
      const response = await transport(input, { ...init, redirect: "error" });
      onResponse?.(response.status);
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      )
        this.stopped = "permanent_http_error";
      return response;
    };
  }
}
