import type { RouteReport } from "../src/router.ts";

export interface EvaluationRow {
  caseId: string;
  attempt: number;
  required: string[];
  allowed: string[];
  selected: string[];
  report: RouteReport;
}

export function percentile(
  values: readonly number[],
  fraction: number,
): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

export function summarize(
  rows: readonly EvaluationRow[],
  prices?: { input: number; output: number },
) {
  let required = 0;
  let recalled = 0;
  let predictions = 0;
  let falsePositives = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let completeUsage = true;
  for (const row of rows) {
    // Full-catalog fallback is not a successful prediction and cannot inflate recall.
    const predicted =
      row.report.status === "selected"
        ? new Set(row.selected)
        : new Set<string>();
    required += row.required.length;
    recalled += row.required.filter((name) => predicted.has(name)).length;
    predictions += predicted.size;
    falsePositives += [...predicted].filter(
      (name) => !row.allowed.includes(name),
    ).length;
    const usage = row.report.usage;
    if (!usage || usage.input_tokens === null || usage.output_tokens === null)
      completeUsage = false;
    inputTokens += usage?.input_tokens ?? 0;
    outputTokens += usage?.output_tokens ?? 0;
  }
  const successful = rows.filter((row) => row.report.status === "selected");
  const zeroHit = rows.filter(
    (row) => row.required.length === 0 && row.allowed.length === 0,
  );
  const zeroCorrect = zeroHit.filter(
    (row) => row.report.status === "selected" && row.selected.length === 0,
  ).length;
  return {
    requests: rows.length,
    successful: successful.length,
    fallbacks: rows.filter((row) => row.report.status === "fallback").length,
    cancelled: rows.filter((row) => row.report.status === "cancelled").length,
    blocked: rows.filter((row) => row.report.status === "blocked").length,
    requiredSkillRecall: required ? recalled / required : null,
    requiredSkills: required,
    recalledSkills: recalled,
    falsePositiveSelections: falsePositives,
    falseDiscoveryRate: predictions ? falsePositives / predictions : null,
    zeroHitAccuracy: zeroHit.length ? zeroCorrect / zeroHit.length : null,
    latencyMs: {
      p50: percentile(
        rows.map((r) => r.report.elapsedMs),
        0.5,
      ),
      p95: percentile(
        rows.map((r) => r.report.elapsedMs),
        0.95,
      ),
    },
    successfulLatencyMs: {
      p50: percentile(
        successful.map((r) => r.report.elapsedMs),
        0.5,
      ),
      p95: percentile(
        successful.map((r) => r.report.elapsedMs),
        0.95,
      ),
    },
    models: [
      ...new Set(rows.flatMap((r) => (r.report.model ? [r.report.model] : []))),
    ],
    usage: {
      knownInputTokens: inputTokens,
      knownOutputTokens: outputTokens,
      complete: completeUsage,
    },
    estimatedCostUsd:
      completeUsage && prices
        ? (inputTokens * prices.input + outputTokens * prices.output) / 1000000
        : null,
    cacheHitRate: null,
    taskCompletionRate: null,
  };
}
