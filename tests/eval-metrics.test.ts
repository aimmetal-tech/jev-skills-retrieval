import assert from "node:assert/strict";
import { test } from "node:test";
import { type EvaluationRow, percentile, summarize } from "../eval/metrics.ts";

test("evaluation never counts full fallback as successful recall or known total cost", () => {
  const rows: EvaluationRow[] = [
    {
      caseId: "success",
      attempt: 1,
      required: ["pdf"],
      allowed: ["pdf"],
      selected: ["pdf", "slides"],
      report: {
        status: "selected",
        elapsedMs: 10,
        candidateCount: 8,
        selectedCount: 2,
        model: "jev-test",
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    },
    {
      caseId: "failed",
      attempt: 1,
      required: ["slides"],
      allowed: ["slides"],
      selected: ["pdf", "slides"],
      report: {
        status: "fallback",
        elapsedMs: 100,
        candidateCount: 8,
        selectedCount: 8,
        reason: "timeout",
      },
    },
  ];
  const metrics = summarize(rows, { input: 1, output: 2 });
  assert.equal(metrics.requiredSkillRecall, 0.5);
  assert.equal(metrics.falsePositiveSelections, 1);
  assert.equal(metrics.fallbacks, 1);
  assert.equal(metrics.estimatedCostUsd, null);
  assert.equal(metrics.usage.complete, false);
  assert.deepEqual(metrics.latencyMs, { p50: 10, p95: 100 });
  assert.equal(
    summarize(rows.slice(0, 1), { input: 1, output: 2 }).estimatedCostUsd,
    0.00012,
  );
  assert.equal(metrics.taskCompletionRate, null);
  assert.equal(metrics.cacheHitRate, null);
});

test("evaluation zero-hit accuracy includes failures and empty measurements stay unknown", () => {
  const row: EvaluationRow = {
    caseId: "zero",
    attempt: 1,
    required: [],
    allowed: [],
    selected: [],
    report: {
      status: "selected",
      elapsedMs: 1,
      candidateCount: 8,
      selectedCount: 0,
    },
  };
  assert.equal(summarize([row]).zeroHitAccuracy, 1);
  assert.equal(
    summarize([{ ...row, report: { ...row.report, status: "fallback" } }])
      .zeroHitAccuracy,
    0,
  );
  assert.equal(percentile([], 0.95), null);
  const blocked = summarize([
    { ...row, report: { ...row.report, status: "blocked" } },
  ]);
  assert.equal(blocked.blocked, 1);
  assert.equal(blocked.zeroHitAccuracy, 0);
  assert.equal(summarize([]).requiredSkillRecall, null);
});
