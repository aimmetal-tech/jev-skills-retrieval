import type { Skill } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "./config.ts";
import type { RoutingState } from "./context.ts";
import {
  type EvaluationResult,
  type Evaluator,
  type FailureCode,
  RoutingFailure,
} from "./jev-client.ts";
import {
  type CatalogSnapshot,
  prepareCatalog,
  selectAutomatic,
} from "./selection.ts";

export interface RouteReport {
  status: "selected" | "fallback" | "cancelled" | "blocked";
  reason?: FailureCode;
  message?: string;
  httpStatus?: number;
  serviceErrorType?: RoutingFailure["serviceErrorType"];
  timeoutPhase?: "preparation" | "evaluation" | "total";
  elapsedMs: number;
  timings?: {
    preparationMs: number;
    evaluationMs: number;
    selectionMs: number;
  };
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
  fileReadTool?: "read" | "bash" | "indirect";
  prepared?: CatalogSnapshot;
  /** Local preparation only; credential input/crypto waiting is excluded. */
  preparationMs?: number;
}

export async function route(
  request: RouteRequest,
  evaluate: Evaluator,
): Promise<RouteResult> {
  const started = performance.now();
  const priorPreparationMs = request.preparationMs ?? 0;
  // Check cancellation before touching the filesystem, including direct route callers.
  if (request.signal?.aborted)
    return {
      skills: [...request.pinned],
      report: {
        status: "cancelled",
        elapsedMs: priorPreparationMs,
        candidateCount: request.prepared?.candidates.length ?? 0,
        selectedCount: request.pinned.length,
      },
    };
  const prepared =
    request.prepared ??
    prepareCatalog(request.catalog, { pinned: request.pinned });
  const { candidates } = prepared;
  const timings = {
    preparationMs: priorPreparationMs + performance.now() - started,
    evaluationMs: 0,
    selectionMs: 0,
  };
  const elapsed = () => priorPreparationMs + performance.now() - started;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let timeoutPhase: RouteReport["timeoutPhase"];
  let observedResult: EvaluationResult | undefined;
  const report = (
    status: RouteReport["status"],
    skills: Skill[],
    extra: Partial<RouteReport> = {},
  ): RouteResult => ({
    skills,
    report: {
      status,
      elapsedMs: elapsed(),
      timings: { ...timings },
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
    const timeoutFailure = (
      phase: NonNullable<RouteReport["timeoutPhase"]>,
    ) => {
      timeoutPhase = phase;
      controller.abort();
      return new RoutingFailure(
        "timeout",
        phase === "total"
          ? `Routing exceeded the ${request.config.routeTimeoutMs} ms total deadline.`
          : `Routing exceeded the ${request.config[phase === "preparation" ? "preparationTimeoutMs" : "evaluationTimeoutMs"]} ms ${phase} deadline.`,
      );
    };
    // Synchronous filesystem work cannot be preempted by a timer. Check it before
    // any remote work and retain the independent total safety deadline.
    if (timings.preparationMs >= request.config.preparationTimeoutMs)
      throw timeoutFailure("preparation");
    const remainingMs = request.config.routeTimeoutMs - elapsed();
    if (remainingMs <= 0) throw timeoutFailure("total");
    const evaluationMs = Math.min(
      remainingMs,
      request.config.evaluationTimeoutMs,
    );
    const deadlinePhase = evaluationMs < remainingMs ? "evaluation" : "total";
    // SDK construction, transport, body parsing and validation share this cap.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutFailure(deadlinePhase));
      }, evaluationMs);
      onAbort = () => {
        controller.abort();
        reject(new Error("cancelled"));
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) onAbort();
    });
    const evaluationStarted = performance.now();
    let result: EvaluationResult;
    try {
      result = await Promise.race([
        deadline,
        evaluate({
          state: request.state,
          candidates,
          signal: controller.signal,
          timeoutMs: Math.max(1, Math.floor(evaluationMs)),
          ...(request.config.model ? { model: request.config.model } : {}),
          ...(request.config.baseUrl
            ? { baseUrl: request.config.baseUrl }
            : {}),
        }),
      ]);
      observedResult = result;
    } finally {
      timings.evaluationMs = performance.now() - evaluationStarted;
    }
    if (request.signal?.aborted) return cancelled();
    if (timings.evaluationMs >= evaluationMs)
      throw timeoutFailure(deadlinePhase);
    const selectionStarted = performance.now();
    const automatic = selectAutomatic(
      candidates,
      result.probabilities,
      request.config,
      request.fileReadTool,
    );
    const selected = prepared.merge([...prepared.pinned, ...automatic]);
    timings.selectionMs = performance.now() - selectionStarted;
    if (elapsed() >= request.config.routeTimeoutMs)
      throw timeoutFailure("total");
    return report("selected", selected, {
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
      prepared.merge([...prepared.pinned, ...prepared.catalog]),
      {
        reason: failure.code,
        message: failure.message,
        ...(failure.serviceErrorType
          ? { serviceErrorType: failure.serviceErrorType }
          : {}),
        ...(observedResult
          ? { model: observedResult.model, usage: observedResult.usage }
          : {}),
        ...(failure.code === "timeout"
          ? { timeoutPhase: timeoutPhase ?? "evaluation" }
          : {}),
        ...(failure.httpStatus === undefined
          ? {}
          : { httpStatus: failure.httpStatus }),
      },
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) request.signal?.removeEventListener("abort", onAbort);
  }
}
