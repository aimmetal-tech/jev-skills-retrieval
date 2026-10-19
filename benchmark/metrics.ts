import type { Trial } from "./types.ts";

export function retrieval(
  predictions: readonly string[],
  gold: readonly string[],
) {
  const predicted = new Set(predictions);
  const truth = new Set(gold);
  const hits = [...predicted].filter((id) => truth.has(id)).length;
  const precision = predicted.size ? hits / predicted.size : truth.size ? 0 : 1;
  const recall = truth.size ? hits / truth.size : predicted.size ? 0 : 1;
  return {
    precision,
    recall,
    f1:
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    complete: [...truth].every((id) => predicted.has(id)),
    hits,
    predicted: predicted.size,
    relevant: truth.size,
  };
}

// Curated bundles retain only the evidence fields consumed by these metrics.
export type SummaryTrial = Pick<
  Trial,
  | "suite"
  | "group"
  | "selectedIds"
  | "relevantIds"
  | "status"
  | "pi"
  | "jev"
  | "recovery"
  | "taskSuccess"
  | "verifierStatus"
  | "elapsedMs"
> & {
  reads: Pick<Trial["reads"][number], "id">[];
  routeReports: Pick<Trial["routeReports"][number], "status">[];
};

export function summarizeTrials(
  rows: SummaryTrial[],
  expectedPerGroup: Record<string, number>,
) {
  return ["skillret", "skillsbench"].flatMap((suite) =>
    ["native", "router"].map((group) => {
      const subset = rows.filter((r) => r.suite === suite && r.group === group);
      const scores = subset.map((r) =>
        retrieval(
          r.reads.map((x) => x.id),
          r.relevantIds,
        ),
      );
      const routes = subset.filter((r) => r.group === "router");
      // Fallback/blocked routes are failed decisions, never perfect full-corpus recall.
      const routeScores = routes.map((r) =>
        r.routeReports.length === 1 && r.routeReports[0]?.status === "selected"
          ? retrieval(r.selectedIds, r.relevantIds)
          : { f1: 0 },
      );
      const mean = (values: number[]) =>
        values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : null;
      const pi = subset.reduce((n, r) => n + r.pi.total, 0);
      const jev = subset.reduce((n, r) => n + r.jev.total, 0);
      const completeUsage =
        subset.length > 0 &&
        subset.every((r) => r.pi.complete && r.jev.complete);
      const successes = subset.filter((r) =>
        suite === "skillsbench"
          ? r.taskSuccess === true
          : r.status === "completed" &&
            retrieval(
              r.reads.map((x) => x.id),
              r.relevantIds,
            ).complete,
      ).length;
      return {
        suite,
        group,
        expected: expectedPerGroup[suite] ?? 0,
        attempted: subset.length,
        coverage: subset.length / (expectedPerGroup[suite] || 1),
        readPrecision: mean(scores.map((s) => s.precision)),
        readRecall: mean(scores.map((s) => s.recall)),
        readF1: mean(scores.map((s) => s.f1)),
        routeF1: group === "router" ? mean(routeScores.map((s) => s.f1)) : null,
        successes,
        successRate: subset.length ? successes / subset.length : null,
        completed: subset.filter((r) => r.status === "completed").length,
        fallbacks: subset.filter((r) =>
          r.routeReports.some((x) => x.status === "fallback"),
        ).length,
        verifierErrors: subset.filter((r) => r.verifierStatus === "error")
          .length,
        piTokensKnown: pi,
        jevTokensKnown: jev,
        usageComplete: completeUsage,
        unknownUsageRequests: subset.reduce(
          (n, r) =>
            n +
            (r.recovery?.unknownRequests ??
              (!r.pi.complete || !r.jev.complete ? 1 : 0)),
          0,
        ),
        totalTokens: completeUsage ? pi + jev : null,
        tokensPerSuccess:
          completeUsage && successes ? (pi + jev) / successes : null,
        meanLatencyMs: mean(subset.map((r) => r.elapsedMs)),
      };
    }),
  );
}
