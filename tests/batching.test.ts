import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { Fetch } from "@typesafe-ai/sdk";
import { type BatchAttempt, planBatches } from "../src/batching.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildRoutingState } from "../src/context.ts";
import {
  createJevEvaluator,
  type EvaluationResult,
  jevRequest,
  RoutingFailure,
} from "../src/jev-client.ts";
import { route } from "../src/router.ts";
import { type Candidate, prepareCatalog } from "../src/selection.ts";

const config = {
  ...DEFAULT_CONFIG,
  batchConcurrency: 1,
  batchMaxRetries: 0,
  batchIntervalMs: 0,
  routeTimeoutMs: 2000,
  evaluationTimeoutMs: 1800,
};
const state = buildRoutingState("Use the appropriate skill", [], [], config);
function catalog(count: number) {
  return Array.from(
    { length: count },
    (_, i) =>
      ({
        name: `skill-${i}`,
        description: `quoted "text" 中文 \\ ${i}`,
        filePath: `/fixture/${i}/SKILL.md`,
        baseDir: `/fixture/${i}`,
        disableModelInvocation: false,
      }) as Skill,
  );
}
function fixture(count = 4) {
  const prepared = prepareCatalog(catalog(count), { identity: (path) => path });
  const bytes = Math.max(
    ...prepared.candidates.map((c) =>
      Buffer.byteLength(JSON.stringify(jevRequest(state, [c], config.model))),
    ),
  );
  return {
    prepared,
    settings: {
      ...config,
      batchMaxPayloadBytes: bytes,
      batchMaxPairBytes: bytes,
    },
  };
}
function answer(
  candidates: readonly Candidate[],
  model = "jev-fixture",
): EvaluationResult {
  return {
    probabilities: Object.fromEntries(
      candidates.map((c) => [c.id, c.skill.name === "skill-3" ? 0.99 : 0.1]),
    ),
    model,
    usage: { input_tokens: 20, output_tokens: 2 },
  };
}

test("byte packing preserves all 6006 candidates and matches exact serialized SDK payloads", () => {
  const prepared = prepareCatalog(catalog(6006), { identity: (path) => path });
  const request = {
    state,
    candidates: prepared.candidates,
    ...(config.model ? { model: config.model } : {}),
  };
  const plans = planBatches(request, config);
  assert(plans.length > 1 && plans.length <= config.batchMaxRequests);
  assert.deepEqual(
    plans.flatMap((p) => p.candidates),
    prepared.candidates,
  );
  assert.equal(
    new Set(plans.flatMap((p) => p.candidates.map((c) => c.id))).size,
    6006,
  );
  for (const plan of plans) {
    assert.equal(
      plan.payloadBytes,
      Buffer.byteLength(
        JSON.stringify(jevRequest(state, plan.candidates, config.model)),
      ),
    );
    assert(plan.payloadBytes <= config.batchMaxPayloadBytes);
  }
  assert.deepEqual(planBatches(request, config), plans);
});

test("all local byte, count and duplicate guards run before any evaluator request", async () => {
  const { prepared, settings } = fixture();
  for (const override of [
    { batchMaxPairBytes: 1 },
    { batchMaxPayloadBytes: 1 },
    { batchMaxRequests: 1 },
  ]) {
    let calls = 0;
    const result = await route(
      {
        catalog: prepared.catalog,
        pinned: [],
        prepared,
        state,
        config: { ...settings, ...override },
        signal: undefined,
        issues: [],
      },
      async () => {
        calls++;
        throw new Error("Must not call");
      },
    );
    assert.equal(calls, 0);
    assert.equal(result.report.reason, "input_limit");
    assert.equal(result.report.batches?.attempts.length, 0);
    assert.equal(result.report.serviceErrorType, undefined);
  }
  assert.throws(
    () =>
      planBatches(
        {
          state,
          candidates: [
            prepared.candidates[0] as Candidate,
            prepared.candidates[0] as Candidate,
          ],
        },
        settings,
      ),
    /Duplicate/,
  );
});

test("real SDK calls are strictly serial, paced, accounted before dispatch, and globally selected", async () => {
  const { prepared, settings } = fixture();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let accounted = 0;
  let lastEnd = 0;
  const seen: string[] = [];
  const evaluate = createJevEvaluator({
    getApiKey: () => "fixture-only",
    fetch: async (_url, init) => {
      assert.equal(accounted, calls);
      if (calls) assert(performance.now() - lastEnd >= 5);
      maxActive = Math.max(maxActive, ++active);
      calls++;
      let bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      if (new Headers(init?.headers).get("content-encoding") === "zstd")
        bytes = zstdDecompressSync(bytes);
      const body = JSON.parse(bytes.toString());
      assert.deepEqual(JSON.parse(body.state), state);
      assert.equal(body.model, "jev-1.14.0");
      const ids = Object.keys(body.questions);
      assert.equal(ids.length, 1);
      seen.push(...ids);
      await delay(5);
      active--;
      lastEnd = performance.now();
      const response = answer(
        prepared.candidates.filter((c) => ids.includes(c.id)),
      );
      return Response.json({
        model: response.model,
        usage: response.usage,
        answers: Object.fromEntries(
          ids.map((id) => [
            id,
            { type: "noul", noul: response.probabilities[id] },
          ]),
        ),
      });
    },
  });
  const result = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: { ...settings, batchIntervalMs: 10 },
      signal: undefined,
      issues: [],
      onAttempt: () => {
        accounted++;
      },
    },
    evaluate,
  );
  assert.equal(maxActive, 1);
  assert.equal(calls, 4);
  assert.equal(accounted, 4);
  assert.deepEqual(
    seen,
    prepared.candidates.map((c) => c.id),
  );
  assert.equal(result.report.status, "selected");
  assert.deepEqual(
    result.skills.map((s) => s.name),
    ["skill-3"],
  );
  assert.equal(result.report.batches?.coverageComplete, true);
  assert.deepEqual(result.report.usage, { input_tokens: 80, output_tokens: 8 });
});

test("a failed later batch preserves known costs and never selects a partial result or retries", async () => {
  const { prepared, settings } = fixture();
  for (const status of [400, 401, 429, 500]) {
    let calls = 0;
    const attempts: BatchAttempt[] = [];
    const evaluate = createJevEvaluator({
      getApiKey: () => "fixture-only",
      fetch: async (_url, init) => {
        calls++;
        if (calls === 2)
          return Response.json(
            {
              detail: {
                error_type: "max_tokens_exceeded",
                message: "secret server detail",
              },
            },
            { status },
          );
        const body = JSON.parse(
          Buffer.from(await new Response(init?.body).arrayBuffer()).toString(),
        );
        return Response.json({
          model: "same",
          usage: { input_tokens: 20, output_tokens: 2 },
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [
              id,
              { type: "noul", noul: 0.99 },
            ]),
          ),
        });
      },
    });
    const result = await route(
      {
        catalog: prepared.catalog,
        pinned: [],
        prepared,
        state,
        config: settings,
        signal: undefined,
        issues: [],
        onAttempt: (a) => attempts.push(a),
      },
      evaluate,
    );
    assert.equal(calls, 2);
    assert.equal(result.report.status, "fallback");
    assert.equal(result.skills.length, 4);
    assert.equal(result.report.batches?.completed, 1);
    assert.equal(result.report.batches?.knownUsage.input_tokens, 20);
    assert.equal(result.report.usage?.input_tokens, null);
    assert.equal(attempts.length, 2);
    assert.doesNotMatch(JSON.stringify(result.report), /secret server detail/);
  }
});

test("unknown usage and mixed models stop further batches without losing known usage", async () => {
  const { prepared, settings } = fixture();
  for (const mode of ["unknown", "model", "missing-id"] as const) {
    let calls = 0;
    const result = await route(
      {
        catalog: prepared.catalog,
        pinned: [],
        prepared,
        state,
        config: settings,
        signal: undefined,
        issues: [],
      },
      async ({ candidates }) => {
        calls++;
        const result = answer(
          candidates,
          mode === "model" && calls === 2 ? "other" : "same",
        );
        if (mode === "unknown") result.usage.output_tokens = null;
        if (mode === "missing-id" && calls === 2) result.probabilities = {};
        return result;
      },
    );
    assert.equal(calls, mode === "unknown" ? 1 : 2);
    assert.equal(result.report.status, "fallback");
    assert.equal(result.report.batches?.coverageComplete, false);
    assert.equal(result.report.batches?.knownUsage.input_tokens, calls * 20);
    assert.equal(result.report.batches?.usageComplete, mode !== "unknown");
  }
});

test("per-batch timeout, whole-phase expiry in pacing, and cancellation never dispatch another batch", async () => {
  const { prepared, settings } = fixture();
  let abort: AbortSignal | undefined;
  const hung = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: { ...settings, batchTimeoutMs: 15 },
      signal: undefined,
      issues: [],
    },
    async (r) => {
      abort = r.signal;
      return new Promise(() => {});
    },
  );
  assert.equal(hung.report.timeoutPhase, "batch");
  assert.equal(abort?.aborted, true);
  assert.equal(hung.report.batches?.attempts.length, 1);
  const sdkTimeout = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: { ...settings, batchTimeoutMs: 15 },
      signal: undefined,
      issues: [],
    },
    async () => {
      throw new RoutingFailure("timeout", "SDK timeout fixture");
    },
  );
  assert.equal(sdkTimeout.report.timeoutPhase, "batch");
  let calls = 0;
  const paced = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: { ...settings, evaluationTimeoutMs: 20, batchIntervalMs: 100 },
      signal: undefined,
      issues: [],
    },
    async ({ candidates }) => {
      calls++;
      return answer(candidates);
    },
  );
  assert.equal(calls, 1);
  assert.equal(paced.report.timeoutPhase, "evaluation");
  assert.equal(paced.report.batches?.knownUsage.input_tokens, 20);
  const controller = new AbortController();
  const stopped = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: settings,
      signal: controller.signal,
      issues: [],
      onAttempt: () => controller.abort(),
    },
    async ({ candidates }) => answer(candidates),
  );
  assert.equal(stopped.report.status, "cancelled");
  assert.equal(stopped.report.batches?.completed, 1);
});

async function requestIds(init: Parameters<Fetch>[1]) {
  let bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
  if (new Headers(init?.headers).get("content-encoding") === "zstd")
    bytes = zstdDecompressSync(bytes);
  return Object.keys(JSON.parse(bytes.toString()).questions);
}

function sdkAnswer(candidates: readonly Candidate[]) {
  const result = answer(candidates);
  return Response.json({
    model: result.model,
    usage: result.usage,
    answers: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        { type: "noul", noul: result.probabilities[candidate.id] },
      ]),
    ),
  });
}

test("bounded SDK workers overlap three batches and refill slots before a slow peer finishes", async () => {
  const { prepared, settings } = fixture(6);
  let releaseSlow: () => void = () => {};
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let active = 0;
  let peak = 0;
  let starts = 0;
  let slowFinished = false;
  const attempts: BatchAttempt[] = [];
  const evaluate = createJevEvaluator({
    getApiKey: () => "fake-only",
    fetch: async (_url, init) => {
      const ids = await requestIds(init);
      starts++;
      peak = Math.max(peak, ++active);
      if (starts === 1) {
        await slow;
        slowFinished = true;
      } else {
        if (starts === 4) {
          assert.equal(slowFinished, false);
          releaseSlow();
        }
        await delay(3);
      }
      active--;
      return sdkAnswer(
        prepared.candidates.filter((candidate) => ids.includes(candidate.id)),
      );
    },
  });
  try {
    const result = await route(
      {
        catalog: prepared.catalog,
        pinned: [],
        prepared,
        state,
        config: { ...settings, batchConcurrency: 3 },
        signal: undefined,
        issues: [],
        onAttempt: (attempt) => attempts.push(attempt),
      },
      evaluate,
    );
    assert.equal(result.report.status, "selected");
    assert.equal(peak, 3);
    assert.equal(active, 0);
    assert.equal(starts, 6);
    assert.equal(result.report.batches?.peakConcurrency, 3);
    assert.equal(result.report.batches?.coverageComplete, true);
    assert.equal(
      new Set(
        attempts.map(
          (attempt) => `${attempt.batchId}/${attempt.attemptNumber}`,
        ),
      ).size,
      6,
    );
    assert.deepEqual(
      result.skills.map((skill) => skill.name),
      ["skill-3"],
    );
    assert.deepEqual(result.report.usage, {
      input_tokens: 120,
      output_tokens: 12,
    });
  } finally {
    releaseSlow();
  }
});

test("SDK 429 recovery shares Retry-After cooldown, reduces concurrency and accounts every attempt once", async () => {
  const { prepared, settings } = fixture(6);
  let active = 0;
  let peakAfterCooldown = 0;
  let limitedAt = 0;
  let calls = 0;
  const starts: number[] = [];
  const attempts: BatchAttempt[] = [];
  const progress: string[] = [];
  const evaluate = createJevEvaluator({
    getApiKey: () => "fake-only",
    fetch: async (_url, init) => {
      const ids = await requestIds(init);
      calls++;
      starts.push(performance.now());
      active++;
      if (limitedAt && performance.now() >= limitedAt + 40)
        peakAfterCooldown = Math.max(peakAfterCooldown, active);
      if (calls === 1) {
        await delay(3);
        limitedAt = performance.now();
        active--;
        return Response.json(
          {
            usage: { input_tokens: 7, output_tokens: 1 },
            detail: "private-rate-limit-body",
          },
          { status: 429, headers: { "retry-after-ms": "40" } },
        );
      }
      await delay(6);
      active--;
      return sdkAnswer(
        prepared.candidates.filter((candidate) => ids.includes(candidate.id)),
      );
    },
  });
  const result = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: {
        ...settings,
        batchConcurrency: 3,
        batchMaxRetries: 2,
        batchRetryBaseMs: 5,
        batchRetryMaxMs: 10,
      },
      signal: undefined,
      issues: [],
      onAttempt: (attempt) => attempts.push(attempt),
      onProgress: (value) =>
        progress.push(`${value.phase}/${value.concurrency}`),
    },
    evaluate,
  );
  assert.equal(result.report.status, "selected");
  assert.equal(calls, 7);
  assert.equal(attempts.length, 7);
  assert.equal(
    attempts.find((attempt) => attempt.httpStatus === 429)?.retryAfterMs,
    40,
  );
  assert(starts.slice(3).every((start) => start - limitedAt >= 39));
  assert.equal(peakAfterCooldown, 1);
  assert(progress.includes("cooldown/1"));
  assert.equal(result.report.batches?.effectiveConcurrency, 1);
  assert.equal(result.report.batches?.rateLimits, 1);
  assert.equal(result.report.batches?.retries, 1);
  assert.equal(result.report.batches?.completed, 6);
  assert.deepEqual(result.report.usage, {
    input_tokens: 127,
    output_tokens: 13,
  });
  assert.doesNotMatch(JSON.stringify(result.report), /private-rate-limit-body/);
});

test("concurrent 429 responses extend a shared cooldown to the longest server delay", async () => {
  const { prepared, settings } = fixture();
  let calls = 0;
  let lastLimit = 0;
  const starts: number[] = [];
  const result = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: {
        ...settings,
        batchConcurrency: 3,
        batchMaxRetries: 1,
        batchRetryBaseMs: 5,
        batchRetryMaxMs: 10,
      },
      signal: undefined,
      issues: [],
    },
    createJevEvaluator({
      getApiKey: () => "fake-only",
      fetch: async (_url, init) => {
        const ids = await requestIds(init);
        const call = ++calls;
        starts.push(performance.now());
        if (call <= 2) {
          await delay(call === 1 ? 3 : 6);
          if (call === 2) lastLimit = performance.now();
          return Response.json(
            { usage: { input_tokens: 0, output_tokens: 0 } },
            {
              status: 429,
              headers: { "retry-after-ms": call === 1 ? "10" : "50" },
            },
          );
        }
        await delay(8);
        return sdkAnswer(
          prepared.candidates.filter((candidate) => ids.includes(candidate.id)),
        );
      },
    }),
  );
  assert.equal(result.report.status, "selected");
  assert.equal(calls, 6);
  assert(starts.slice(3).every((start) => start - lastLimit >= 49));
  assert.equal(result.report.batches?.rateLimits, 2);
  assert.equal(result.report.batches?.retries, 2);
  assert.equal(result.report.batches?.effectiveConcurrency, 1);
});

test("unknown 429 cost stays unknown after successful retry without blocking complete score coverage", async () => {
  const { prepared, settings } = fixture(2);
  let calls = 0;
  const evaluate = createJevEvaluator({
    getApiKey: () => "fake-only",
    fetch: async (_url, init) => {
      const ids = await requestIds(init);
      if (++calls === 1) return Response.json({}, { status: 429 });
      return sdkAnswer(
        prepared.candidates.filter((candidate) => ids.includes(candidate.id)),
      );
    },
  });
  const result = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: {
        ...settings,
        batchMaxRetries: 1,
        batchRetryBaseMs: 5,
        batchRetryMaxMs: 10,
      },
      signal: undefined,
      issues: [],
    },
    evaluate,
  );
  assert.equal(calls, 3);
  assert.equal(result.report.status, "selected");
  assert.equal(result.report.batches?.coverageComplete, true);
  assert.equal(result.report.batches?.usageComplete, false);
  assert.equal(result.report.batches?.knownUsage.input_tokens, 40);
  assert.deepEqual(result.report.usage, {
    input_tokens: null,
    output_tokens: null,
  });
});

test("repeated 429 stops at the retry budget and never selects partial scores", async () => {
  const { prepared, settings } = fixture();
  let calls = 0;
  const result = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: {
        ...settings,
        batchMaxRetries: 2,
        batchRetryBaseMs: 5,
        batchRetryMaxMs: 10,
      },
      signal: undefined,
      issues: [],
    },
    createJevEvaluator({
      getApiKey: () => "fake-only",
      fetch: async () => {
        calls++;
        return Response.json(
          { usage: { input_tokens: 7, output_tokens: 1 } },
          { status: 429 },
        );
      },
    }),
  );
  assert.equal(calls, 3);
  assert.equal(result.report.status, "fallback");
  assert.equal(result.report.reason, "rate_limit");
  assert.equal(result.report.batches?.retries, 2);
  assert.equal(result.report.batches?.completed, 0);
  assert.equal(result.report.batches?.attempts.length, 3);
  assert.deepEqual(result.report.usage, { input_tokens: 21, output_tokens: 3 });
});

test("long Retry-After seconds and HTTP dates obey the existing deadline instead of retrying early", async () => {
  const { prepared, settings } = fixture();
  for (const header of ["60", new Date(Date.now() + 60000).toUTCString()]) {
    let calls = 0;
    const result = await route(
      {
        catalog: prepared.catalog,
        pinned: [],
        prepared,
        state,
        config: { ...settings, batchMaxRetries: 2, evaluationTimeoutMs: 60 },
        signal: undefined,
        issues: [],
      },
      createJevEvaluator({
        getApiKey: () => "fake-only",
        fetch: async () => {
          calls++;
          return Response.json(
            {},
            { status: 429, headers: { "Retry-After": header } },
          );
        },
      }),
    );
    assert.equal(calls, 1);
    assert.equal(result.report.reason, "timeout");
    assert.equal(result.report.timeoutPhase, "evaluation");
    assert((result.report.batches?.attempts[0]?.retryAfterMs ?? 0) > 50000);
  }
});

test("cancellation interrupts cooldown without another dispatch or hanging on Retry-After", {
  timeout: 1000,
}, async () => {
  const { prepared, settings } = fixture();
  const controller = new AbortController();
  let calls = 0;
  const result = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: { ...settings, batchMaxRetries: 2 },
      signal: controller.signal,
      issues: [],
      onProgress: (progress) => {
        if (progress.phase === "cooldown") controller.abort();
      },
    },
    createJevEvaluator({
      getApiKey: () => "fake-only",
      fetch: async () => {
        calls++;
        return Response.json(
          {},
          { status: 429, headers: { "Retry-After": "60" } },
        );
      },
    }),
  );
  assert.equal(result.report.status, "cancelled");
  assert.equal(calls, 1);
  assert.equal(result.report.batches?.attempts.length, 1);
});

test("fatal concurrent failure drains admitted attempts, preserves known usage and ignores late results", async () => {
  const { prepared, settings } = fixture();
  let calls = 0;
  let releaseLate: () => void = () => {};
  const late = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  const attempts: BatchAttempt[] = [];
  const pending = route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: { ...settings, batchConcurrency: 3, batchIntervalMs: 100 },
      signal: undefined,
      issues: [],
      onAttempt: (attempt) => attempts.push(attempt),
    },
    async ({ candidates }) => {
      const call = ++calls;
      if (call === 1) {
        await delay(1);
        return answer(candidates);
      }
      if (call === 2) {
        await delay(5);
        const failure = new RoutingFailure(
          "authentication",
          "fixture authentication failure",
          401,
        );
        failure.usage = { input_tokens: 7, output_tokens: 1 };
        throw failure;
      }
      await late;
      return answer(candidates);
    },
  );
  try {
    const result = await pending;
    assert.equal(calls, 3);
    assert.equal(result.report.status, "fallback");
    assert.equal(result.report.reason, "authentication");
    assert.equal(attempts.length, 3);
    assert.equal(result.report.batches?.completed, 1);
    assert.equal(result.report.batches?.knownUsage.input_tokens, 27);
    assert.equal(result.report.usage?.input_tokens, null);
    const before = JSON.stringify(result.report);
    releaseLate();
    await delay(5);
    assert.equal(JSON.stringify(result.report), before);
    assert.equal(attempts.length, 3);
  } finally {
    releaseLate();
  }
});

test("an attempt observer failure aborts peers and cannot release a slot for another queued batch", async () => {
  const { prepared, settings } = fixture(6);
  let calls = 0;
  let settled = 0;
  const result = await route(
    {
      catalog: prepared.catalog,
      pinned: [],
      prepared,
      state,
      config: { ...settings, batchConcurrency: 3 },
      signal: undefined,
      issues: [],
      onAttempt: () => {
        settled++;
        if (settled === 1) throw new Error("private-observer-error");
      },
    },
    async ({ candidates, signal }) => {
      const call = ++calls;
      if (call === 1) return answer(candidates);
      return new Promise<EvaluationResult>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("private-abort-error")),
          { once: true },
        );
      });
    },
  );
  assert.equal(calls, 3);
  assert.equal(settled, 3);
  assert.equal(result.report.batches?.attempts.length, 3);
  assert.equal(result.report.status, "fallback");
  assert.doesNotMatch(
    JSON.stringify(result.report),
    /private-observer-error|private-abort-error/,
  );
});
