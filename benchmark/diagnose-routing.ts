import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildRoutingState } from "../src/context.ts";
import { createJevEvaluator, type Evaluator } from "../src/jev-client.ts";
import { route } from "../src/router.ts";
import { prepareCatalog, skillIdentity } from "../src/selection.ts";
import { contained, loadSkillret, sha256 } from "./data.ts";
import { createBenchmarkTransport } from "./transport.ts";

// Diagnostic only: one complete catalog, one query, at most one Jev HTTP request.
// No Pi generation and no leaderboard/benchmark accuracy claims.
const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    "timeout-ms": {
      type: "string",
      default: String(DEFAULT_CONFIG.routeTimeoutMs),
    },
    "preparation-timeout-ms": {
      type: "string",
      default: String(DEFAULT_CONFIG.preparationTimeoutMs),
    },
    "evaluation-timeout-ms": {
      type: "string",
      default: String(DEFAULT_CONFIG.evaluationTimeoutMs),
    },
    output: { type: "string", default: `diagnostics/routing-${Date.now()}` },
  },
});
const durations = [
  "timeout-ms",
  "preparation-timeout-ms",
  "evaluation-timeout-ms",
] as const;
for (const key of durations) {
  const duration = Number(values[key]);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 2147483647)
    throw new Error("Invalid timeout");
}
if (values.live && !process.env.TYPESAFE_API_KEY?.trim())
  throw new Error("Missing TYPESAFE_API_KEY; no request sent");
const root = resolve(import.meta.dirname, "..");
const output = contained(resolve(root, "outputs/benchmark"), values.output);
await mkdir(output, { recursive: true });
const loaded = await loadSkillret(resolve(root, "outputs/benchmark/data"));
const query = loaded.queries[0];
if (!query) throw new Error("No query");
let canonicalLookups = 0;
const started = performance.now();
const prepared = prepareCatalog(loaded.catalog, {
  identity: (path) => {
    canonicalLookups++;
    return skillIdentity(path);
  },
});
const preparationMs = performance.now() - started;
const config = {
  ...DEFAULT_CONFIG,
  routeTimeoutMs: Number(values["timeout-ms"]),
  preparationTimeoutMs: Number(values["preparation-timeout-ms"]),
  evaluationTimeoutMs: Number(values["evaluation-timeout-ms"]),
};
const evidence = {
  kind: values.live
    ? "live-single-jev-routing-diagnostic"
    : "offline-routing-diagnostic",
  startedAt: new Date().toISOString(),
  catalogSize: prepared.catalog.length,
  candidateDigest: sha256(JSON.stringify(prepared.candidates.map((c) => c.id))),
  sourceDigest: sha256(
    (
      await Promise.all(
        ["selection.ts", "router.ts", "config.ts", "pi-adapter.ts"].map(
          (file) => readFile(resolve(root, "src", file), "utf8"),
        ),
      )
    ).join("\n"),
  ),
  queryId: query.id,
  config,
  preparationMs,
  canonicalLookups,
  note: "One diagnostic query; no Pi model or task execution. Failed requests may have unknown token usage.",
};
await writeFile(
  resolve(output, "preparation.json"),
  JSON.stringify(evidence, null, 2),
);
const transport = createBenchmarkTransport(values.live ? process.env : {});
let requests = 0;
let httpStatus: number | null = null;
let fetchStartedMs: number | null = null;
let headersReceivedMs: number | null = null;
let requestBytes: number | null = null;
const evaluate: Evaluator = values.live
  ? createJevEvaluator({
      fetch: async (input, init) => {
        if (requests >= 1) throw new Error("Diagnostic request cap");
        requests++;
        fetchStartedMs = performance.now() - started;
        if (typeof init?.body === "string")
          requestBytes = Buffer.byteLength(init.body);
        else if (init?.body instanceof Uint8Array)
          requestBytes = init.body.byteLength;
        const response = await transport.fetch(input, init);
        httpStatus = response.status;
        headersReceivedMs = performance.now() - started;
        return response;
      },
    })
  : async ({ candidates }) => ({
      probabilities: Object.fromEntries(candidates.map((c) => [c.id, 0])),
      model: "offline-fixture-no-network",
      usage: { input_tokens: null, output_tokens: null },
    });
try {
  const result = await route(
    {
      catalog: prepared.catalog,
      pinned: prepared.pinned,
      prepared,
      preparationMs,
      state: buildRoutingState(query.query, [], [], config),
      config,
      signal: undefined,
      issues: prepared.issues,
    },
    evaluate,
  );
  const report = {
    ...evidence,
    canonicalLookups,
    requests,
    httpStatus,
    requestBytes,
    fetchStartedMs,
    headersReceivedMs,
    report: result.report,
    selected:
      result.report.status === "selected"
        ? result.skills.map((s) => s.name)
        : [],
  };
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await transport.close();
}
