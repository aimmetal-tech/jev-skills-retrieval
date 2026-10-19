/** Export/verify a small, allowlisted derivative; never mutate frozen evidence. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  retrieval,
  type SummaryTrial,
  summarizeTrials,
} from "../benchmark/metrics.ts";
import type { Trial } from "../benchmark/types.ts";

const output = resolve(
  import.meta.dirname,
  "../docs/benchmarks/2026-10-19-skillret-paused-212",
);
const expected = { skillret: 4392, skillsbench: 0 };
const sha256 = (data: string) =>
  createHash("sha256").update(data).digest("hex");
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const skillId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

type Compact = Pick<
  Trial,
  | "caseId"
  | "suite"
  | "group"
  | "status"
  | "relevantIds"
  | "pi"
  | "jev"
  | "requests"
  | "elapsedMs"
  | "parallelTiming"
  | "recovery"
> & {
  readIds: string[];
  selectedIds?: string[];
  routeStatus?: Trial["routeReports"][number]["status"];
};

function compact(row: Trial): Compact {
  assert.equal(row.model, "gpt-6-luna");
  assert.deepEqual(row.responseModels, ["gpt-6-luna"]);
  assert.equal(row.execution?.provider, "openai");
  assert.equal(row.execution?.authentication, "pi-oauth");
  assert.equal(row.execution?.thinking, "medium");
  assert.equal(row.evidence, "live");
  assert.equal(row.catalogCount, 6006);
  assert.equal(row.routeReports.length, row.group === "router" ? 1 : 0);
  const route = row.routeReports[0];
  if (route) assert.equal(route.model, "jev-1.14.0");
  return {
    caseId: row.caseId,
    suite: row.suite,
    group: row.group,
    status: row.status,
    relevantIds: row.relevantIds,
    readIds: row.reads.map((read) => read.id),
    ...(route
      ? {
          selectedIds: row.selectedIds,
          routeStatus: route.status,
        }
      : {}),
    pi: row.pi,
    jev: row.jev,
    requests: row.requests,
    elapsedMs: row.elapsedMs,
    ...(row.parallelTiming ? { parallelTiming: row.parallelTiming } : {}),
    ...(row.recovery ? { recovery: row.recovery } : {}),
  };
}

function validate(rows: Compact[]) {
  assert.equal(rows.length, 424);
  const keys = new Set<string>();
  const allowed = new Set([
    "caseId",
    "suite",
    "group",
    "status",
    "relevantIds",
    "readIds",
    "selectedIds",
    "routeStatus",
    "pi",
    "jev",
    "requests",
    "elapsedMs",
    "parallelTiming",
    "recovery",
  ]);
  for (const row of rows) {
    assert(Object.keys(row).every((key) => allowed.has(key)));
    assert(/^q-\d{5}$/.test(row.caseId));
    assert.equal(row.suite, "skillret");
    assert(["native", "router"].includes(row.group));
    assert.equal(row.status, "completed");
    const key = `${row.caseId}/${row.group}`;
    assert(!keys.has(key), `Duplicate ${key}`);
    keys.add(key);
    assert(
      [...row.relevantIds, ...row.readIds, ...(row.selectedIds ?? [])].every(
        (id) => skillId.test(id),
      ),
    );
    for (const count of [row.pi, row.jev]) {
      assert(
        Object.keys(count).every((key) =>
          [
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "reasoning",
            "total",
            "complete",
          ].includes(key),
        ),
      );
      assert.equal(typeof count.complete, "boolean");
      for (const field of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "total",
      ] as const) {
        assert(Number.isSafeInteger(count[field]) && count[field] >= 0);
      }
      assert.equal(
        count.total,
        count.input + count.output + count.cacheRead + count.cacheWrite,
      );
    }
    assert(
      Object.keys(row.requests).every((key) => ["pi", "jev"].includes(key)),
    );
    if (row.recovery) {
      assert(
        Object.keys(row.recovery).every((key) =>
          ["schemaVersion", "resumes", "replayed", "unknownRequests"].includes(
            key,
          ),
        ),
      );
      assert(
        Object.keys(row.recovery.replayed).every((key) =>
          ["pi", "jev"].includes(key),
        ),
      );
    }
    if (row.parallelTiming) {
      assert(
        Object.keys(row.parallelTiming).every((key) =>
          [
            "workMs",
            "queueMs",
            "backoffMs",
            "cooldownMs",
            "onlineMs",
            "routeWorkMs",
            "naturalStartedAt",
            "savedAt",
            "resumes",
          ].includes(key),
        ),
      );
    }
    assert(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0);
  }
  assert.equal(new Set(rows.map((row) => row.caseId)).size, 212);
  for (const row of rows) {
    assert(
      keys.has(`${row.caseId}/${row.group === "native" ? "router" : "native"}`),
    );
  }
}

function derive(rows: Compact[]) {
  validate(rows);
  const trials: (SummaryTrial & { caseId: string })[] = rows.map((row) => ({
    ...row,
    selectedIds: row.selectedIds ?? [],
    reads: row.readIds.map((id) => ({ id })),
    routeReports: row.routeStatus ? [{ status: row.routeStatus }] : [],
    taskSuccess: null,
    verifierStatus: "not_applicable",
  }));
  const ids = [...new Set(rows.map((row) => row.caseId))].sort();
  const completeIds = ids.filter((id) =>
    rows
      .filter((row) => row.caseId === id)
      .every((row) => row.pi.complete && row.jev.complete),
  );
  assert.equal(completeIds.length, 199);
  const groups = (subset: SummaryTrial[]) =>
    summarizeTrials(subset, expected).filter(
      (group) => group.suite === "skillret",
    );
  const summary = {
    schemaVersion: 1,
    evidence: "live:paused:completed-pairs-only",
    pairedQueries: 212,
    completeUsagePairs: 199,
    expectedQueriesPerGroup: 4392,
    groups: groups(trials),
    completeUsageGroups: groups(
      trials.filter((row) => completeIds.includes(row.caseId)),
    ),
  };
  const header =
    "caseId,nativePrecision,nativeRecall,nativeF1,routerPrecision,routerRecall,routerF1,deltaF1,nativeTokensKnown,routerTokensKnown,bothUsageComplete";
  const csv = `${[
    header,
    ...ids.map((id) => {
      const native = rows.find(
        (row) => row.caseId === id && row.group === "native",
      );
      const router = rows.find(
        (row) => row.caseId === id && row.group === "router",
      );
      assert(native && router);
      assert.deepEqual(native.relevantIds, router.relevantIds);
      const n = retrieval(native.readIds, native.relevantIds);
      const r = retrieval(router.readIds, router.relevantIds);
      return [
        id,
        n.precision,
        n.recall,
        n.f1,
        r.precision,
        r.recall,
        r.f1,
        r.f1 - n.f1,
        native.pi.total + native.jev.total,
        router.pi.total + router.jev.total,
        completeIds.includes(id),
      ].join(",");
    }),
  ].join("\n")}\n`;
  return { summary, csv };
}

const args = process.argv.slice(2);
assert(
  args.length === 0 ||
    (args.length === 3 && args[0] === "--source" && args[2] === "--write"),
  "Usage: npm run results:verify; or tsx scripts/publish-snapshot.ts --source <frozen-directory> --write",
);
if (args[0] === "--source") {
  const source = resolve(args[1] ?? "");
  assert(source !== output, "Source must be the original frozen evidence");
  const inputs = [
    "reports/paired-completed/results.jsonl",
    "reports/paired-completed/summary.json",
    "reports/paired-usage-complete/summary.json",
    "reports/paired-queries.csv",
    "reports/snapshot.json",
    "provenance/sources.json",
    "provenance/prepared-data-manifest.json",
    "archive-verification.json",
  ];
  const files = new Map(
    await Promise.all(
      inputs.map(
        async (path) =>
          [path, await readFile(resolve(source, path), "utf8")] as const,
      ),
    ),
  );
  const get = (path: string) => {
    const value = files.get(path);
    assert(value !== undefined);
    return value;
  };
  const rows = get(inputs[0] ?? "")
    .trim()
    .split(/\r?\n/)
    .map((line) => compact(JSON.parse(line)));
  const { summary, csv } = derive(rows);
  for (const [path, groups] of [
    ["reports/paired-completed/summary.json", summary.groups],
    ["reports/paired-usage-complete/summary.json", summary.completeUsageGroups],
  ] as const) {
    assert.deepEqual(
      groups,
      JSON.parse(get(path)).groups.filter(
        (group: { suite: string }) => group.suite === "skillret",
      ),
    );
  }
  assert.equal(csv, get("reports/paired-queries.csv").replaceAll("\r\n", "\n"));
  const snapshot = JSON.parse(get("reports/snapshot.json"));
  const sources = JSON.parse(get("provenance/sources.json"));
  const manifest = JSON.parse(get("provenance/prepared-data-manifest.json"));
  const archive = JSON.parse(get("archive-verification.json"));
  const products = {
    "compact-evidence.jsonl": `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "summary.json": pretty(summary),
    "paired-queries.csv": csv,
  };
  const provenance = {
    schemaVersion: 1,
    project: "jev-skills-retrieval",
    sourceRunId: "per-group-20261019-104926-full-5",
    frozenSnapshotId: "per-group-20261019-104926-stopped-20261019-142910",
    stoppedAt: snapshot.stoppedAt,
    sourceCommit: snapshot.sourceCommit,
    originalParallelCommit: "bb2391e97225c1d9612191a6e7a86354b5bdaec7",
    dataset: sources.skillret,
    execution: {
      provider: sources.executionProvider,
      model: sources.executionModel,
      authentication: sources.executionAuth,
      thinking: sources.executionThinking,
      piVersion: sources.piVersion,
      jevModel: "jev-1.14.0",
    },
    legacyPreparedManifestModelLabel: manifest.sources.executionModel,
    coverage: {
      nativeCompleted: snapshot.counts.native.completed,
      routerCompleted: snapshot.counts.router.completed,
      paired: 212,
      completeUsagePaired: 199,
      expectedPerGroup: 4392,
      catalogSkills: 6006,
    },
    archive: {
      bytes: archive.archiveBytes,
      sha256: archive.archiveSha256,
      verifiedSourceFiles: archive.verifiedFiles,
      published: false,
    },
    sourceJournalSha256: snapshot.sourceJournalSha256,
    sourceFilesSha256: Object.fromEntries(
      [...files].map(([path, data]) => [path, sha256(data)]),
    ),
    filesSha256: Object.fromEntries(
      Object.entries(products).map(([path, data]) => [path, sha256(data)]),
    ),
    limitations: [
      "Completed common-query subset, not a random/full-test estimate",
      "Metadata adaptation; not an official SkillRet leaderboard or SkillsBench task result",
      "Unknown usage retained; main-sample total tokens and tokens/success remain null",
      "Cache counted once; reasoning is an output subset; token counts are not billed cost",
      "Harness repaired during run; online timing includes queue, retries and recovery",
      "Curated IDs/usage permit metric recomputation, not independent regrading of raw responses",
    ],
  };
  await mkdir(output, { recursive: true });
  for (const [path, data] of Object.entries({
    ...products,
    "provenance.json": pretty(provenance),
  })) {
    await writeFile(resolve(output, path), data);
  }
}

const provenance = JSON.parse(
  await readFile(resolve(output, "provenance.json"), "utf8"),
);
for (const [path, hash] of Object.entries(provenance.filesSha256)) {
  assert(
    ["compact-evidence.jsonl", "summary.json", "paired-queries.csv"].includes(
      path,
    ),
  );
  assert.equal(
    sha256(await readFile(resolve(output, path), "utf8")),
    hash,
    `${path}: hash mismatch`,
  );
}
const rows = (await readFile(resolve(output, "compact-evidence.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line)) as Compact[];
const recomputed = derive(rows);
assert.deepEqual(
  recomputed.summary,
  JSON.parse(await readFile(resolve(output, "summary.json"), "utf8")),
);
assert.equal(
  recomputed.csv,
  await readFile(resolve(output, "paired-queries.csv"), "utf8"),
);
console.log(
  "Verified offline: 212 paired queries; 199 complete-usage pairs; source-matched metrics, CSV and SHA256. No model calls.",
);
