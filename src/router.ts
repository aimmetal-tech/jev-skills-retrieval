import type { Skill } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "./config.ts";
import type { RoutingState } from "./context.ts";
import {
  type EvaluationResult,
  type Evaluator,
  type FailureCode,
  RoutingFailure,
} from "./jev-client.ts";
import { autoCandidates, selectAutomatic, uniqueSkills } from "./selection.ts";

export interface RouteReport {
  status: "selected" | "fallback" | "cancelled";
  reason?: FailureCode;
  message?: string;
  elapsedMs: number;
  candidateCount: number;
  selectedCount: number;
  model?: string;
  usage?: EvaluationResult["usage"];
}
export interface RouteResult {
  skills: Skill[];
  report: RouteReport;
}
export interface RouteRequest {
  catalog: readonly Skill[];
  pinned: readonly Skill[];
  state: RoutingState;
  config: RouterConfig;
  signal: AbortSignal | undefined;
  issues: readonly string[];
}

export async function route(
  request: RouteRequest,
  evaluate: Evaluator,
): Promise<RouteResult> {
  const started = performance.now();
  const candidates = autoCandidates(request.catalog, request.pinned);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const report = (
    status: RouteReport["status"],
    skills: Skill[],
    extra: Partial<RouteReport> = {},
  ): RouteResult => ({
    skills,
    report: {
      status,
      elapsedMs: performance.now() - started,
      candidateCount: candidates.length,
      selectedCount: skills.length,
      ...extra,
    },
  });
  const cancelled = () => report("cancelled", [...request.pinned]);
  if (request.signal?.aborted) return cancelled();
  try {
    if (request.issues.length)
      throw new RoutingFailure("invalid_config", request.issues.join("; "));
    if (
      candidates.length === 0 ||
      request.config.maxAutoSkills === 0 ||
      request.config.autoMetadataMaxChars === 0
    )
      return report("selected", [...request.pinned]);
    const remainingMs =
      request.config.routeTimeoutMs - (performance.now() - started);
    const timeoutFailure = () =>
      new RoutingFailure(
        "timeout",
        `Routing exceeded the ${request.config.routeTimeoutMs} ms total deadline.`,
      );
    if (remainingMs <= 0) throw timeoutFailure();
    // Cover construction, transport, body parsing and validation with one deadline.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutFailure());
      }, remainingMs);
      onAbort = () => {
        controller.abort();
        reject(new Error("cancelled"));
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
    });
    const result = await Promise.race([
      deadline,
      evaluate({
        state: request.state,
        candidates,
        signal: controller.signal,
        timeoutMs: Math.max(1, Math.floor(remainingMs)),
        ...(request.config.model ? { model: request.config.model } : {}),
      }),
    ]);
    if (request.signal?.aborted) return cancelled();
    const automatic = selectAutomatic(
      candidates,
      result.probabilities,
      request.config,
    );
    if (performance.now() - started >= request.config.routeTimeoutMs)
      throw timeoutFailure();
    return report("selected", uniqueSkills([...request.pinned, ...automatic]), {
      model: result.model,
      usage: result.usage,
    });
  } catch (error) {
    if (request.signal?.aborted) return cancelled();
    const failure =
      error instanceof RoutingFailure
        ? error
        : new RoutingFailure("service_error", "Unexpected routing failure.");
    return report(
      "fallback",
      uniqueSkills([...request.pinned, ...request.catalog]),
      { reason: failure.code, message: failure.message },
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) request.signal?.removeEventListener("abort", onAbort);
  }
}
