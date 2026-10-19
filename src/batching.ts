import { setMaxListeners } from "node:events";
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
  attemptNumber: number;
  candidateCount: number;
  payloadBytes: number;
  elapsedMs: number;
  status: "completed" | "failed" | "cancelled";
  reason?: string;
  httpStatus?: number;
  serviceErrorType?: "max_tokens_exceeded";
  model?: string;
  usage: EvaluationResult["usage"];
  retryAfterMs?: number;
}
export interface BatchProgress {
  phase: "evaluating" | "cooldown";
  concurrency: number;
  completed: number;
  planned: number;
  retries: number;
}
export interface BatchReport {
  concurrency: number;
  effectiveConcurrency: number;
  peakConcurrency: number;
  retries: number;
  rateLimits: number;
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

/** Bounded workers share 429 cooldown; every admitted attempt settles before return. */
export async function evaluateBatches(
  request: EvaluationRequest,
  evaluate: Evaluator,
  config: RouterConfig,
  onAttempt?: (attempt: BatchAttempt) => void,
  onProgress?: (progress: BatchProgress) => void,
): Promise<EvaluationResult & { batches: BatchReport }> {
  const batches: BatchReport = {
    concurrency: config.batchConcurrency,
    effectiveConcurrency: config.batchConcurrency,
    peakConcurrency: 0,
    retries: 0,
    rateLimits: 0,
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
  setMaxListeners(config.batchConcurrency + 2, parent.signal);
  let phase: "batch" | "evaluation" | undefined;
  let terminal: RoutingFailure | undefined;
  let active = 0;
  let cooldownUntil = 0;
  const wakeups = new Set<() => void>();
  const wake = () => {
    for (const finish of [...wakeups]) finish();
  };
  const timeout = () =>
    new RoutingFailure("timeout", "Jev batched evaluation deadline exceeded.");
  const remaining = () => request.timeoutMs - (performance.now() - started);
  const stop = (
    failure: RoutingFailure,
    timeoutPhase?: "batch" | "evaluation",
  ) => {
    if (!terminal) {
      terminal = failure;
      phase = timeoutPhase;
    }
    parent.abort();
    wake();
  };
  const cancelled = () => stop(timeout());
  request.signal.addEventListener("abort", cancelled, { once: true });
  if (request.signal.aborted) cancelled();
  const check = () => {
    if (!terminal && remaining() <= 0) stop(timeout(), "evaluation");
    if (terminal) throw terminal;
  };
  const progress = () =>
    onProgress?.({
      phase: cooldownUntil > performance.now() ? "cooldown" : "evaluating",
      concurrency: batches.effectiveConcurrency,
      completed: batches.completed,
      planned: batches.planned,
      retries: batches.retries,
    });
  const waitForChange = (ms?: number) =>
    new Promise<void>((resolve) => {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (waitTimer) clearTimeout(waitTimer);
        wakeups.delete(finish);
        parent.signal.removeEventListener("abort", finish);
        resolve();
      };
      if (parent.signal.aborted) {
        resolve();
        return;
      }
      wakeups.add(finish);
      parent.signal.addEventListener("abort", finish, { once: true });
      if (ms !== undefined)
        waitTimer = setTimeout(
          finish,
          Math.max(1, Math.min(ms, remaining(), 2147483647)),
        );
    });
  const acquire = async (readyAt: number) => {
    while (true) {
      check();
      const wait = Math.max(readyAt, cooldownUntil) - performance.now();
      if (wait > 0) await waitForChange(wait);
      else if (active < batches.effectiveConcurrency) {
        active++;
        batches.peakConcurrency = Math.max(batches.peakConcurrency, active);
        return;
      } else await waitForChange();
    }
  };
  const timer = setTimeout(
    () => stop(timeout(), "evaluation"),
    Math.max(1, request.timeoutMs),
  );
  const probabilities: Record<string, number> = {};
  let model: string | undefined;
  try {
    check();
    const plans = planBatches(request, config);
    batches.planned = plans.length;
    const execute = async (
      plan: BatchPlan,
      index: number,
      attemptNumber: number,
    ) => {
      check();
      if (attemptNumber > 1) batches.retries++;
      const batchStarted = performance.now();
      const available = remaining();
      const allowance = Math.min(config.batchTimeoutMs, available);
      const limitPhase: "batch" | "evaluation" =
        config.batchTimeoutMs < available ? "batch" : "evaluation";
      const child = new AbortController();
      let batchTimer: ReturnType<typeof setTimeout> | undefined;
      let abortChild: (() => void) | undefined;
      let result: EvaluationResult | undefined;
      let failure: RoutingFailure | undefined;
      let timedOut = false;
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
              timedOut = true;
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
        failure = timedOut
          ? timeout()
          : error instanceof RoutingFailure
            ? error
            : new RoutingFailure(
                "service_error",
                "Unexpected batch evaluation failure.",
              );
        child.abort();
      } finally {
        if (batchTimer) clearTimeout(batchTimer);
        if (abortChild) parent.signal.removeEventListener("abort", abortChild);
      }
      const usage = observedUsage({ usage: result?.usage ?? failure?.usage });
      if (failure?.code === "rate_limit" && failure.httpStatus === 429)
        batches.rateLimits++;
      const actualModel = result?.model ?? failure?.actualModel;
      const attempt: BatchAttempt = {
        batchId: index + 1,
        attemptNumber,
        candidateCount: plan.candidates.length,
        payloadBytes: plan.payloadBytes,
        elapsedMs: performance.now() - batchStarted,
        status:
          request.signal.aborted ||
          (terminal !== undefined && failure !== undefined)
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
        ...(failure?.retryAfterMs !== undefined
          ? { retryAfterMs: failure.retryAfterMs }
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
      if (
        !failure &&
        (usage.input_tokens === null || usage.output_tokens === null) &&
        !batches.coverageComplete
      )
        failure = new RoutingFailure(
          "service_error",
          "Unknown batch usage; further batch requests were stopped.",
        );
      return { failure, limitPhase };
    };
    let next = 0;
    const worker = async () => {
      let readyAt = 0;
      try {
        while (!terminal) {
          const index = next++;
          const plan = plans[index];
          if (!plan) return;
          let attemptNumber = 0;
          while (!terminal) {
            await acquire(readyAt);
            try {
              check();
              attemptNumber++;
              progress();
              const outcome = await execute(plan, index, attemptNumber);
              readyAt = performance.now() + config.batchIntervalMs;
              if (outcome.failure && !terminal) {
                if (
                  outcome.failure.code === "rate_limit" &&
                  outcome.failure.httpStatus === 429
                ) {
                  batches.effectiveConcurrency = Math.max(
                    1,
                    Math.floor(batches.effectiveConcurrency / 2),
                  );
                  const backoff = Math.min(
                    config.batchRetryMaxMs,
                    config.batchRetryBaseMs * 2 ** (attemptNumber - 1),
                  );
                  const wait = Math.max(
                    outcome.failure.retryAfterMs ?? 0,
                    backoff * (1 + Math.random() * 0.2),
                  );
                  cooldownUntil = Math.max(
                    cooldownUntil,
                    performance.now() + wait,
                  );
                  if (attemptNumber > config.batchMaxRetries)
                    stop(outcome.failure);
                } else
                  stop(
                    outcome.failure,
                    outcome.failure.code === "timeout"
                      ? outcome.limitPhase
                      : undefined,
                  );
              }
              if (!terminal) progress();
              if (!outcome.failure) break;
            } catch (error) {
              stop(
                error instanceof RoutingFailure
                  ? error
                  : new RoutingFailure(
                      "service_error",
                      "Batch scheduling stopped.",
                    ),
              );
            } finally {
              active--;
              wake();
            }
          }
        }
      } catch (error) {
        stop(
          error instanceof RoutingFailure
            ? error
            : new RoutingFailure("service_error", "Batch scheduling stopped."),
        );
      }
    };
    await Promise.allSettled(
      Array.from(
        { length: Math.min(config.batchConcurrency, plans.length) },
        worker,
      ),
    );
    check();
    if (!batches.coverageComplete && plans.length)
      throw new RoutingFailure(
        "invalid_response",
        "Incomplete batch coverage.",
      );
    return {
      probabilities: Object.fromEntries(
        request.candidates.map((candidate) => [
          candidate.id,
          probabilities[candidate.id] as number,
        ]),
      ),
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
