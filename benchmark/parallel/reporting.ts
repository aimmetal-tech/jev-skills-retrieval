import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicJson } from "../checkpoint.ts";
import { writeReport } from "../run.ts";
import { emptyCounts, type Trial } from "../types.ts";
import type { Coordinator } from "./coordinator.ts";

export async function phaseReport(coordinator: Coordinator) {
  const rows = coordinator.rows();
  for (const job of coordinator.jobs.values())
    if (job.state !== "completed") {
      const path = resolve(
        coordinator.directory,
        "groups",
        job.group,
        "trials",
        job.caseId,
        "partial.json",
      );
      if (!existsSync(path)) continue;
      const row = JSON.parse(readFileSync(path, "utf8")) as Trial;
      row.status = job.state === "paused" ? "paused" : "running";
      row.pi = emptyCounts();
      row.jev = emptyCounts();
      row.requests = { pi: 0, jev: 0 };
      let unknown = 0;
      for (const a of coordinator.attempts.values())
        if (a.job === job.key) {
          row.requests[a.provider]++;
          const t = row[a.provider];
          for (const k of [
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "total",
          ] as const)
            t[k] += a.usage[k];
          if (a.usage.reasoning !== null)
            t.reasoning = (t.reasoning ?? 0) + a.usage.reasoning;
          t.complete &&= a.state === "settled" && a.usage.complete;
          if (a.state !== "settled" || !a.usage.complete) unknown++;
        }
      row.recovery = {
        schemaVersion: 3,
        resumes: row.recovery?.resumes ?? 0,
        replayed: row.recovery?.replayed ?? { pi: 0, jev: 0 },
        unknownRequests: unknown,
      };
      rows.push(row);
    }
  const summary = await writeReport(
    coordinator.directory,
    rows,
    { skillret: coordinator.spec.queryIds.length, skillsbench: 0 },
    coordinator.spec.evidence === "live",
  );
  atomicJson(resolve(coordinator.directory, "summary.json"), {
    ...summary,
    runId: coordinator.spec.id,
    phaseAccounting: coordinator.summary(),
    notes: [
      ...summary.notes,
      "Running/paused trials are provisional and contribute their observed costs, not successes",
      "All evidence belongs to this phase only; no old run or calibration response imports",
    ],
  });
  atomicJson(resolve(coordinator.directory, "run.json"), {
    ...coordinator.spec,
    status:
      coordinator.fatal || Object.keys(coordinator.pauses).length
        ? "paused"
        : rows.filter((r) => r.status === "completed").length ===
            coordinator.jobs.size
          ? "complete"
          : "running",
    expectedPerGroup: {
      skillret: coordinator.spec.queryIds.length,
      skillsbench: 0,
    },
    oldResultsImported: false,
  });
  return summary;
}
export function qualification(c: Coordinator, elapsedMs: number) {
  const summary = c.summary();
  const eligible =
    c.rows().length === c.jobs.size &&
    c.rows().every((r) => r.status === "completed") &&
    !c.fatal &&
    Object.keys(c.pauses).length === 0 &&
    !c.recovered &&
    c.circuitBreaks === 0 &&
    c.manualInterventions === 0 &&
    summary.rateLimitedFraction <= 0.01;
  return {
    eligible,
    elapsedMs,
    throughputPerHour: c.rows().length / (elapsedMs / 3600000),
    rateLimitedFraction: summary.rateLimitedFraction,
    rows: c.rows().length,
    recovered: c.recovered,
  };
}
export function selectConcurrency(
  three: ReturnType<typeof qualification>,
  five: ReturnType<typeof qualification>,
): 3 | 5 | null {
  if (!three.eligible) return null;
  return five.eligible &&
    five.throughputPerHour >= three.throughputPerHour * 1.2
    ? 5
    : 3;
}
