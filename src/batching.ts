import { setTimeout as delay } from "node:timers/promises";
import type { RouterConfig } from "./config.ts";
import {
  type EvaluationRequest,
  type EvaluationResult,
  type Evaluator,
  jevQuestion,
  jevRequest,
  observedUsage,
  RoutingFailure,
} from "./jev-client.ts";
import type { Candidate } from "./selection.ts";

export interface BatchPlan {
  candidates: Candidate[];
  payloadBytes: number;
}
export interface BatchAttempt {
  batchId: number;
  candidateCount: number;
  payloadBytes: number;
  elapsedMs: number;
  status: "completed" | "failed" | "cancelled";
  reason?: string;
  httpStatus?: number;
  serviceErrorType?: "max_tokens_exceeded";
  model?: string;
  usage: EvaluationResult["usage"];
}
export interface BatchReport {
  concurrency: 1;
  planned: number;
  completed: number;
  scoredCandidates: number;
  coverageComplete: boolean;
  usageComplete: boolean;
  knownUsage: { input_tokens: number; output_tokens: number };
  attempts: BatchAttempt[];
}
export class BatchFailure extends RoutingFailure {
  constructor(
    failure: RoutingFailure,
    readonly batches: BatchReport,
    readonly phase?: "batch" | "evaluation",
  ) {
    super(
      failure.code,
      failure.message,
      failure.httpStatus,
      failure.serviceErrorType,
    );
  }
}

/** Exact uncompressed JSON byte guards, NOT an assertion about Jev tokenization. */
export function planBatches(
  request: Pick<EvaluationRequest, "state" | "candidates" | "model">,
  config: RouterConfig,
): BatchPlan[] {
  const baseBytes = Buffer.byteLength(
    JSON.stringify(jevRequest(request.state, [], request.model)),
  );
  const plans: BatchPlan[] = [];
  const ids = new Set<string>();
  for (const candidate of request.candidates) {
    if (ids.has(candidate.id))
      throw new RoutingFailure(
        "invalid_response",
        "Duplicate candidate identity in batch plan.",
      );
    ids.add(candidate.id);
    const entryBytes = Buffer.byteLength(
      `${JSON.stringify(candidate.id)}:${JSON.stringify(jevQuestion(candidate))}`,
    );
    if (
      baseBytes + entryBytes > config.batchMaxPairBytes ||
      baseBytes + entryBytes > config.batchMaxPayloadBytes
    )
      throw new RoutingFailure(
        "input_limit",
        "Local state-plus-question byte guard exceeded; input was not truncated.",
      );
    let last = plans.at(-1);
    const comma = last?.candidates.length ? 1 : 0;
    if (
      !last ||
      last.payloadBytes + entryBytes + comma > config.batchMaxPayloadBytes
    ) {
      if (plans.length >= config.batchMaxRequests)
        throw new RoutingFailure(
          "input_limit",
          "Local maximum batch request count exceeded; no candidate was dropped.",
        );
      last = { candidates: [], payloadBytes: baseBytes };
      plans.push(last);
    }
    last.payloadBytes += entryBytes + (last.candidates.length ? 1 : 0);
    last.candidates.push(candidate);
  }
  return plans;
}

export function batchUsage(report: BatchReport): EvaluationResult["usage"] {
  return {
    input_tokens: report.attempts.every((a) => a.usage.input_tokens !== null)
      ? report.knownUsage.input_tokens
      : null,
    output_tokens: report.attempts.every((a) => a.usage.output_tokens !== null)
      ? report.knownUsage.output_tokens
      : null,
  };
}

/** Strictly serial: settle, validate and synchronously account before dispatching another. */
export async function evaluateBatches(
  request: EvaluationRequest,
  evaluate: Evaluator,
  config: RouterConfig,
  onAttempt?: (attempt: BatchAttempt) => void,
): Promise<EvaluationResult & { batches: BatchReport }> {
  const batches: BatchReport = {
    concurrency: 1,
    planned: 0,
    completed: 0,
    scoredCandidates: 0,
    coverageComplete: false,
    usageComplete: true,
    knownUsage: { input_tokens: 0, output_tokens: 0 },
    attempts: [],
  };
  const started = performance.now();
  const parent = new AbortController();
  let phase: "batch" | "evaluation" | undefined;
  const cancelled = () => parent.abort();
  request.signal.addEventListener("abort", cancelled, { once: true });
  if (request.signal.aborted) parent.abort();
  const timeout = () =>
    new RoutingFailure("timeout", "Jev batched evaluation deadline exceeded.");
  const remaining = () => request.timeoutMs - (performance.now() - started);
  const timer = setTimeout(
    () => {
      phase = "evaluation";
      parent.abort();
    },
    Math.max(1, request.timeoutMs),
  );
  const probabilities: Record<string, number> = {};
  let model: string | undefined;
  try {
    const plans = planBatches(request, config);
    batches.planned = plans.length;
    for (const [index, plan] of plans.entries()) {
      if (parent.signal.aborted || remaining() <= 0) throw timeout();
      if (index > 0 && config.batchIntervalMs > 0) {
        await delay(config.batchIntervalMs, undefined, {
          signal: parent.signal,
        });
        if (remaining() <= 0 || parent.signal.aborted) throw timeout();
      }
      const batchStarted = performance.now();
      const available = remaining();
      const allowance = Math.min(config.batchTimeoutMs, available);
      const limitPhase =
        config.batchTimeoutMs < available ? "batch" : "evaluation";
      const child = new AbortController();
      let batchTimer: ReturnType<typeof setTimeout> | undefined;
      let abortChild: (() => void) | undefined;
      let result: EvaluationResult | undefined;
      let failure: RoutingFailure | undefined;
      try {
        const stopped = new Promise<never>((_resolve, reject) => {
          abortChild = () => {
            child.abort();
            reject(timeout());
          };
          parent.signal.addEventListener("abort", abortChild, { once: true });
          if (parent.signal.aborted) abortChild();
          batchTimer = setTimeout(
            () => {
              phase = limitPhase;
              child.abort();
              reject(timeout());
            },
            Math.max(1, allowance),
          );
        });
        result = await Promise.race([
          stopped,
          evaluate({
            ...request,
            candidates: plan.candidates,
            signal: child.signal,
            timeoutMs: Math.max(1, Math.floor(allowance)),
          }),
        ]);
        if (
          performance.now() - batchStarted >= allowance ||
          parent.signal.aborted
        ) {
          phase ??= limitPhase;
          child.abort();
          throw timeout();
        }
        const known = new Set(plan.candidates.map((c) => c.id));
        if (
          !result.model?.trim() ||
          Object.keys(result.probabilities).length !== known.size ||
          Object.entries(result.probabilities).some(
            ([id, p]) =>
              !known.has(id) || !Number.isFinite(p) || p < 0 || p > 1,
          )
        )
          throw new RoutingFailure(
            "invalid_response",
            "Incomplete or invalid batch probabilities.",
          );
        if (model !== undefined && model !== result.model)
          throw new RoutingFailure(
            "invalid_response",
            "Jev returned inconsistent models across batches.",
          );
        model = result.model;
        Object.assign(probabilities, result.probabilities);
        batches.completed++;
        batches.scoredCandidates += plan.candidates.length;
      } catch (error) {
        failure =
          error instanceof RoutingFailure
            ? error
            : new RoutingFailure(
                "service_error",
                "Unexpected batch evaluation failure.",
              );
        child.abort();
        if (failure.code === "timeout") phase ??= limitPhase;
      } finally {
        if (batchTimer) clearTimeout(batchTimer);
        if (abortChild) parent.signal.removeEventListener("abort", abortChild);
      }
      const usage = observedUsage({ usage: result?.usage ?? failure?.usage });
      const actualModel = result?.model ?? failure?.actualModel;
      const attempt: BatchAttempt = {
        batchId: index + 1,
        candidateCount: plan.candidates.length,
        payloadBytes: plan.payloadBytes,
        elapsedMs: performance.now() - batchStarted,
        status: request.signal.aborted
          ? "cancelled"
          : failure
            ? "failed"
            : "completed",
        usage,
        ...(actualModel ? { model: actualModel } : {}),
        ...(failure ? { reason: failure.code } : {}),
        ...(failure?.httpStatus ? { httpStatus: failure.httpStatus } : {}),
        ...(failure?.serviceErrorType
          ? { serviceErrorType: failure.serviceErrorType }
          : {}),
      };
      batches.attempts.push(attempt);
      if (usage.input_tokens !== null)
        batches.knownUsage.input_tokens += usage.input_tokens;
      if (usage.output_tokens !== null)
        batches.knownUsage.output_tokens += usage.output_tokens;
      batches.usageComplete &&=
        usage.input_tokens !== null && usage.output_tokens !== null;
      batches.coverageComplete =
        batches.scoredCandidates === request.candidates.length;
      onAttempt?.(attempt);
      if (failure) throw failure;
      if (!batches.usageComplete && index < plans.length - 1)
        throw new RoutingFailure(
          "service_error",
          "Unknown batch usage; further batch requests were stopped.",
        );
    }
    return {
      probabilities,
      model: model ?? request.model ?? "unknown",
      usage: batchUsage(batches),
      batches,
    };
  } catch (error) {
    parent.abort();
    const failure =
      error instanceof RoutingFailure
        ? error
        : parent.signal.aborted && (request.signal.aborted || remaining() <= 0)
          ? timeout()
          : new RoutingFailure("service_error", "Batch evaluation stopped.");
    throw new BatchFailure(failure, batches, phase);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancelled);
  }
}
