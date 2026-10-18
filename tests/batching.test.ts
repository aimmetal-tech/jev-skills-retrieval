import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import type { Skill } from "@earendil-works/pi-coding-agent";
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
